"""Unit tests for the anomaly scheduler."""

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock

from brain_agents.anomaly.agent import AnomalyAgent
from brain_agents.anomaly.scheduler import AnomalyScheduler, SchedulerConfig
from brain_agents.client import BrainApiClient


def _scan_result(scanned: int = 2, findings: int = 0) -> dict[str, Any]:
    return {
        "kind": "anomaly_scan",
        "scanned": scanned,
        "findings": [
            {
                "transaction_id": f"tx_{i}",
                "category": "outlier_amount",
                "severity": "low",
                "rationale": "test",
                "confidence": 0.5,
            }
            for i in range(findings)
        ],
        "summary": f"{findings} flagged",
    }


def _make_client(
    txs_by_tenant: dict[str, list[dict[str, Any]]] | None = None,
) -> AsyncMock:
    client = AsyncMock(spec=BrainApiClient)

    async def list_recent(tenant_id: str, limit: int = 100) -> list[dict[str, Any]]:
        return (txs_by_tenant or {}).get(tenant_id, [])

    client.list_recent_transactions.side_effect = list_recent
    return client


def _make_agent(result: dict[str, Any] | None = None) -> AsyncMock:
    agent = AsyncMock(spec=AnomalyAgent)
    agent.scan.return_value = result or _scan_result()
    return agent


# ---------------------------------------------------------------------------
# Per-iteration scan logic — tested directly on _scan_all_tenants so we don't
# depend on asyncio timing.
# ---------------------------------------------------------------------------


async def test_scan_iterates_every_configured_tenant() -> None:
    txs = {"tnt_a": [{"id": "tx_1"}], "tnt_b": [{"id": "tx_2"}, {"id": "tx_3"}]}
    client = _make_client(txs)
    agent = _make_agent(_scan_result(scanned=2, findings=1))
    scheduler = AnomalyScheduler(
        agent, client, SchedulerConfig(tenants=("tnt_a", "tnt_b"), batch_size=10)
    )
    await scheduler._scan_all_tenants()

    assert client.list_recent_transactions.await_count == 2
    assert agent.scan.await_count == 2
    seen = [c.args[0] for c in agent.scan.await_args_list]
    assert [{"id": "tx_1"}] in seen
    assert [{"id": "tx_2"}, {"id": "tx_3"}] in seen


async def test_scan_skips_tenant_with_no_transactions_without_calling_agent() -> None:
    client = _make_client({"tnt_a": []})
    agent = _make_agent()
    scheduler = AnomalyScheduler(agent, client, SchedulerConfig(tenants=("tnt_a",)))

    await scheduler._scan_all_tenants()

    assert client.list_recent_transactions.await_count == 1
    agent.scan.assert_not_awaited()


async def test_one_tenant_error_does_not_abort_the_batch() -> None:
    """A list_recent_transactions failure for one tenant must not prevent the
    next tenant from scanning — defense against a single-tenant outage."""
    txs_calls: list[str] = []
    scan_calls: list[list[dict[str, Any]]] = []

    async def list_recent(tenant_id: str, limit: int = 100) -> list[dict[str, Any]]:
        txs_calls.append(tenant_id)
        if tenant_id == "tnt_bad":
            raise RuntimeError("boom")
        return [{"id": f"tx_{tenant_id}"}]

    client = AsyncMock(spec=BrainApiClient)
    client.list_recent_transactions.side_effect = list_recent

    async def fake_scan(transactions: list[dict[str, Any]]) -> dict[str, Any]:
        scan_calls.append(transactions)
        return _scan_result(scanned=len(transactions))

    agent = AsyncMock(spec=AnomalyAgent)
    agent.scan.side_effect = fake_scan

    scheduler = AnomalyScheduler(agent, client, SchedulerConfig(tenants=("tnt_bad", "tnt_good")))
    await scheduler._scan_all_tenants()

    assert txs_calls == ["tnt_bad", "tnt_good"]
    # The bad tenant did not produce a scan, but the good one did.
    assert scan_calls == [[{"id": "tx_tnt_good"}]]


# ---------------------------------------------------------------------------
# Loop lifecycle — only the start/stop contract; iteration logic is above.
# ---------------------------------------------------------------------------


async def test_start_is_a_noop_when_no_tenants_configured() -> None:
    scheduler = AnomalyScheduler(
        _make_agent(), _make_client(), SchedulerConfig(tenants=(), interval_seconds=60)
    )
    scheduler.start()
    # No task spawned; stop() is safe to call.
    await scheduler.stop()


async def test_stop_is_idempotent_and_safe_without_start() -> None:
    scheduler = AnomalyScheduler(_make_agent(), _make_client(), SchedulerConfig(tenants=("tnt_a",)))
    # Never started. stop() must not raise.
    await scheduler.stop()
    await scheduler.stop()


async def test_scan_posts_each_finding_to_raw_ingest() -> None:
    """Anomaly findings are durable evidence: each finding becomes a Raw
    artifact (sourceType=anomaly_finding) so it shows up in audit logs and
    is queryable per tenant."""
    txs = {"tnt_a": [{"id": "tx_1"}, {"id": "tx_2"}]}
    client = _make_client(txs)
    client.raw_ingest = AsyncMock(return_value={"rawId": "raw_1"})

    agent = _make_agent(
        {
            "kind": "anomaly_scan",
            "scanned": 2,
            "findings": [
                {
                    "transaction_id": "tx_1",
                    "category": "outlier_amount",
                    "severity": "high",
                    "rationale": "5x larger than vendor avg",
                    "confidence": 0.9,
                },
                {
                    "transaction_id": "tx_2",
                    "category": "duplicate_suspect",
                    "severity": "medium",
                    "rationale": "amount matches tx_1",
                    "confidence": 0.7,
                },
            ],
            "summary": "2 flagged",
        }
    )

    scheduler = AnomalyScheduler(agent, client, SchedulerConfig(tenants=("tnt_a",)))
    await scheduler._scan_all_tenants()

    assert client.raw_ingest.await_count == 2
    # sourceRef carries tenant + tx id so the lookup is unambiguous.
    refs = [c.args[0]["sourceRef"] for c in client.raw_ingest.await_args_list]
    assert refs == ["tnt_a:tx_1", "tnt_a:tx_2"]
    # body is JSON-encoded with tenant_id preserved.
    payloads = [json.loads(c.args[0]["body"]) for c in client.raw_ingest.await_args_list]
    assert payloads[0]["transaction_id"] == "tx_1"
    assert payloads[0]["tenant_id"] == "tnt_a"
    assert payloads[1]["category"] == "duplicate_suspect"


async def test_scan_does_not_call_ingest_when_findings_are_empty() -> None:
    """Empty findings ⇒ no raw_ingest calls (no noise into the audit chain)."""
    txs = {"tnt_a": [{"id": "tx_1"}]}
    client = _make_client(txs)
    client.raw_ingest = AsyncMock(return_value={"rawId": "raw_1"})
    agent = _make_agent(_scan_result(scanned=1, findings=0))

    scheduler = AnomalyScheduler(agent, client, SchedulerConfig(tenants=("tnt_a",)))
    await scheduler._scan_all_tenants()
    client.raw_ingest.assert_not_awaited()


async def test_per_finding_ingest_failure_does_not_abort_the_batch() -> None:
    """A raw_ingest exception for one finding must not skip the rest."""
    txs = {"tnt_a": [{"id": "tx_1"}, {"id": "tx_2"}, {"id": "tx_3"}]}
    client = _make_client(txs)
    posted_ids: list[str] = []

    async def flaky_ingest(env: dict[str, Any]) -> dict[str, Any]:
        ref = env["sourceRef"]
        if "tx_2" in ref:
            raise RuntimeError("transient")
        posted_ids.append(ref)
        return {"rawId": "raw_" + ref}

    client.raw_ingest = AsyncMock(side_effect=flaky_ingest)
    agent = _make_agent(
        {
            "kind": "anomaly_scan",
            "scanned": 3,
            "findings": [
                {
                    "transaction_id": "tx_1",
                    "category": "outlier_amount",
                    "severity": "low",
                    "rationale": "",
                    "confidence": 0.5,
                },
                {
                    "transaction_id": "tx_2",
                    "category": "outlier_amount",
                    "severity": "low",
                    "rationale": "",
                    "confidence": 0.5,
                },
                {
                    "transaction_id": "tx_3",
                    "category": "outlier_amount",
                    "severity": "low",
                    "rationale": "",
                    "confidence": 0.5,
                },
            ],
            "summary": "3 flagged",
        }
    )

    scheduler = AnomalyScheduler(agent, client, SchedulerConfig(tenants=("tnt_a",)))
    await scheduler._scan_all_tenants()

    # tx_1 and tx_3 still posted; tx_2 was skipped silently.
    assert posted_ids == ["tnt_a:tx_1", "tnt_a:tx_3"]


async def test_start_then_stop_wakes_the_sleeping_loop_promptly() -> None:
    """The wait-with-stop helper must yield as soon as stop() fires, not
    after the full interval. This is how shutdown stays fast."""
    client = _make_client({"tnt_a": []})
    scheduler = AnomalyScheduler(
        _make_agent(),
        client,
        SchedulerConfig(tenants=("tnt_a",), interval_seconds=3600),
    )
    scheduler.start()
    # Give the loop a moment to enter the sleep wait.
    await asyncio.sleep(0.05)
    # stop() must complete within ~1s even though the configured interval is 1h.
    await asyncio.wait_for(scheduler.stop(), timeout=1)
