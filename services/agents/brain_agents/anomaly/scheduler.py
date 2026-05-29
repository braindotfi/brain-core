"""Anomaly-scan scheduler.

Periodic background task that invokes the anomaly agent on a recent
transaction batch per configured tenant. Completes the "autonomous finance"
narrative: the anomaly agent runs on a cadence, not only when invoked.

Findings are logged with structured output today. A follow-up wires them as
Wiki annotations + a policy-evaluable signal (per the agent's contract: never
auto-proposes, advisory only).

Configuration:
  BRAIN_ANOMALY_SCAN_INTERVAL_SECONDS  default 3600 (1h)
  BRAIN_ANOMALY_SCAN_TENANTS           comma-separated tenant ids; empty disables
  BRAIN_ANOMALY_SCAN_BATCH_SIZE        default 100
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from brain_agents.anomaly.agent import AnomalyAgent
from brain_agents.client import BrainApiClient

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
            except Exception:
                logger.exception("anomaly scan failed tenant=%s", tenant_id)
