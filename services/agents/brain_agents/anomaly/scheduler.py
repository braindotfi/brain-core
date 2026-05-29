"""Anomaly-scan scheduler.

Periodic background task that invokes the anomaly agent on a recent
transaction batch per configured tenant. Completes the "autonomous finance"
narrative: the anomaly agent runs on a cadence, not only when invoked.

Findings are now posted to the Brain Raw layer as
`sourceType=anomaly_finding` artifacts (one per finding). Once in Raw they are:
  - audit-emitted (Layer 6 picks them up automatically)
  - queryable via /v1/raw/* (operators can list per-tenant findings)
  - eligible inputs for downstream Wiki annotation + Policy signals

Configuration:
  BRAIN_ANOMALY_SCAN_INTERVAL_SECONDS  default 3600 (1h)
  BRAIN_ANOMALY_SCAN_TENANTS           comma-separated tenant ids; empty disables
  BRAIN_ANOMALY_SCAN_BATCH_SIZE        default 100
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any

from brain_agents.anomaly.agent import AnomalyAgent
from brain_agents.client import BrainApiClient

ANOMALY_SOURCE_TYPE = "anomaly_finding"

logger = logging.getLogger("brain_agents.anomaly.scheduler")


@dataclass(frozen=True)
class SchedulerConfig:
    interval_seconds: int = 3600
    tenants: tuple[str, ...] = ()
    batch_size: int = 100


class AnomalyScheduler:
    """Owns the background scan loop.

    The loop:
      1. Sleeps `interval_seconds`.
      2. For each tenant in `tenants`, fetches the last `batch_size`
         transactions via BrainApiClient.list_recent_transactions.
      3. Invokes the anomaly agent's `scan()`.
      4. Logs findings with the tenant id.

    Loop runs until `stop()` is called. Per-tenant errors are logged but
    never abort the loop; the next interval retries.
    """

    def __init__(
        self,
        agent: AnomalyAgent,
        brain_client: BrainApiClient,
        config: SchedulerConfig,
    ) -> None:
        self._agent = agent
        self._client = brain_client
        self._cfg = config
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if len(self._cfg.tenants) == 0:
            logger.info(
                "anomaly scheduler not started: no tenants configured "
                "(set BRAIN_ANOMALY_SCAN_TENANTS to enable)"
            )
            return
        if self._task is not None:
            return
        logger.info(
            "anomaly scheduler started interval=%ss tenants=%d batch=%d",
            self._cfg.interval_seconds,
            len(self._cfg.tenants),
            self._cfg.batch_size,
        )
        self._task = asyncio.create_task(self._run(), name="anomaly-scheduler")

    async def stop(self) -> None:
        if self._task is None:
            return
        self._stop.set()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        finally:
            self._task = None

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                await self._sleep_or_stop(self._cfg.interval_seconds)
                if self._stop.is_set():
                    return
                await self._scan_all_tenants()
            except Exception:
                logger.exception("anomaly scheduler iteration crashed")

    async def _sleep_or_stop(self, seconds: float) -> None:
        """Sleep that wakes early when stop() is called."""
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=seconds)
        except TimeoutError:
            return

    async def _scan_all_tenants(self) -> None:
        for tenant_id in self._cfg.tenants:
            try:
                txs = await self._client.list_recent_transactions(
                    tenant_id, limit=self._cfg.batch_size
                )
                if len(txs) == 0:
                    logger.info("anomaly scan tenant=%s skipped (no rows)", tenant_id)
                    continue
                result = await self._agent.scan(txs)
                findings = result.get("findings", [])
                logger.info(
                    "anomaly scan tenant=%s scanned=%d findings=%d summary=%r",
                    tenant_id,
                    result.get("scanned", len(txs)),
                    len(findings),
                    result.get("summary", ""),
                )
                await self._post_findings(tenant_id, findings)
            except Exception:
                logger.exception("anomaly scan failed tenant=%s", tenant_id)

    async def _post_findings(self, tenant_id: str, findings: list[dict[str, Any]]) -> None:
        """Post each finding to /v1/raw/ingest as a typed evidence artifact.

        One transaction may produce zero findings (the agent's contract says
        empty when nothing is anomalous), so a normal scan often emits
        nothing. Per-finding failures are logged but never abort the scan;
        the next interval retries the whole batch.
        """
        posted = 0
        skipped = 0
        for finding in findings:
            txid = finding.get("transaction_id")
            if not isinstance(txid, str):
                skipped += 1
                continue
            envelope = {
                "sourceType": ANOMALY_SOURCE_TYPE,
                "sourceRef": f"{tenant_id}:{txid}",
                "mimeType": "application/json",
                "body": json.dumps({**finding, "tenant_id": tenant_id}).encode("utf-8"),
            }
            try:
                await self._client.raw_ingest(envelope)
                posted += 1
            except Exception:
                logger.exception("anomaly finding ingest failed tenant=%s tx=%s", tenant_id, txid)
                skipped += 1
        if posted > 0 or skipped > 0:
            logger.info(
                "anomaly findings ingested tenant=%s posted=%d skipped=%d",
                tenant_id,
                posted,
                skipped,
            )
