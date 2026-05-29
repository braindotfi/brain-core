"""Unit tests for the anomaly scheduler."""

import asyncio
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
