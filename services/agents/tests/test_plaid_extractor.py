"""Unit tests for the Plaid extractor agent and its HTTP route."""

import json
from collections.abc import AsyncGenerator
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from brain_agents.anomaly.agent import AnomalyAgent
from brain_agents.client import BrainApiClient
from brain_agents.deps import AppDeps
from brain_agents.payment.agent import PaymentAgent
from brain_agents.plaid_extractor.agent import PlaidExtractorAgent
from brain_agents.reconciliation.agent import ReconciliationAgent
from brain_agents.server import create_app


def _ingest_result(raw_id: str = "raw_01TEST000000000000000000") -> dict[str, Any]:
    return {
        "rawId": raw_id,
        "sha256": "0" * 64,
        "bytes": 42,
        "sourceType": "plaid_transactions_sync",
        "ingestedAt": "2025-01-01T00:00:00Z",
        "deduplicated": False,
    }


def _make_mock_deps() -> AppDeps:
    mock_brain: AsyncMock = AsyncMock(spec=BrainApiClient)
    mock_brain.raw_ingest.return_value = _ingest_result()
    return AppDeps(
        brain_client=mock_brain,
        recon_agent=AsyncMock(spec=ReconciliationAgent),
        payment_agent=AsyncMock(spec=PaymentAgent),
        anomaly_agent=AsyncMock(spec=AnomalyAgent),
        plaid_extractor_agent=PlaidExtractorAgent(),  # deterministic; no LLM
    )


@pytest.fixture
def mock_deps() -> AppDeps:
    return _make_mock_deps()


@pytest.fixture
async def client(mock_deps: AppDeps) -> AsyncGenerator[httpx.AsyncClient, None]:
    app = create_app(deps=mock_deps)
    app.state.deps = mock_deps
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),  # type: ignore[arg-type]
        base_url="http://test",
    ) as c:
        yield c


# ---------------------------------------------------------------------------
# PlaidExtractorAgent unit tests
# ---------------------------------------------------------------------------


def test_extractor_emits_one_envelope_per_added_transaction() -> None:
    agent = PlaidExtractorAgent()
    payload = {
        "added": [
            {"transaction_id": "tx_1", "amount": 1.0},
            {"transaction_id": "tx_2", "amount": 2.0},
        ],
        "modified": [],
        "removed": [],
        "next_cursor": "cur_001",
    }
    envs = agent.extract(payload)
    assert len(envs) == 2
    assert {e["sourceRef"] for e in envs} == {"tx_1", "tx_2"}
    assert all(e["sourceType"] == "plaid_transactions_sync" for e in envs)
    assert all(e["mimeType"] == "application/json" for e in envs)
    # Body is bytes(JSON) — round-trip the first one to confirm shape.
    assert json.loads(envs[0]["body"].decode("utf-8"))["transaction_id"] == "tx_1"


def test_extractor_emits_removed_envelopes_with_tombstone_marker() -> None:
    agent = PlaidExtractorAgent()
    payload = {"added": [], "modified": [], "removed": [{"transaction_id": "tx_gone"}]}
    envs = agent.extract(payload)
    assert len(envs) == 1
    body = json.loads(envs[0]["body"].decode("utf-8"))
    assert body == {"removed": True, "transaction_id": "tx_gone"}


def test_extractor_handles_modified_alongside_added_and_removed() -> None:
    agent = PlaidExtractorAgent()
    payload = {
        "added": [{"transaction_id": "tx_a"}],
        "modified": [{"transaction_id": "tx_m"}],
        "removed": [{"transaction_id": "tx_r"}],
    }
    envs = agent.extract(payload)
    refs = [e["sourceRef"] for e in envs]
    assert refs == ["tx_a", "tx_m", "tx_r"]


def test_extractor_skips_entries_with_no_transaction_id() -> None:
    agent = PlaidExtractorAgent()
    payload = {
        "added": [{"amount": 1.0}, {"transaction_id": "tx_ok"}],
        "modified": [],
        "removed": [{"not_a_txid": "x"}],
    }
    envs = agent.extract(payload)
    assert len(envs) == 1
    assert envs[0]["sourceRef"] == "tx_ok"


def test_extractor_tolerates_empty_payload() -> None:
    assert PlaidExtractorAgent().extract({}) == []


# ---------------------------------------------------------------------------
# POST /run/plaid_extract route
# ---------------------------------------------------------------------------


async def test_plaid_extract_route_ingests_each_envelope(
    client: httpx.AsyncClient,
    mock_deps: AppDeps,
) -> None:
    resp = await client.post(
        "/run/plaid_extract",
        json={
            "agent_id": "agent_01TEST000000000000000000",
            "tenant_id": "tnt_01TEST000000000000000000",
            "sync_payload": {
                "added": [{"transaction_id": "tx_1"}, {"transaction_id": "tx_2"}],
                "modified": [],
                "removed": [],
            },
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ingested"] == 2
    assert body["skipped"] == 0
    assert mock_deps.brain_client.raw_ingest.await_count == 2  # type: ignore[union-attr]


async def test_plaid_extract_route_records_per_envelope_errors(
    client: httpx.AsyncClient,
    mock_deps: AppDeps,
) -> None:
    """If the API rejects one envelope, the route records skipped + continues."""
    call_count = {"n": 0}

    async def flaky_ingest(env: dict[str, Any]) -> dict[str, Any]:
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("rate limited")
        return _ingest_result()

    mock_deps.brain_client.raw_ingest = AsyncMock(side_effect=flaky_ingest)  # type: ignore[union-attr]
    resp = await client.post(
        "/run/plaid_extract",
        json={
            "agent_id": "agent_01TEST000000000000000000",
            "tenant_id": "tnt_01TEST000000000000000000",
            "sync_payload": {
                "added": [{"transaction_id": "tx_1"}, {"transaction_id": "tx_2"}],
                "modified": [],
                "removed": [],
            },
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ingested"] == 1
    assert body["skipped"] == 1
    assert any("rate limited" in str(r.get("error", "")) for r in body["results"])
