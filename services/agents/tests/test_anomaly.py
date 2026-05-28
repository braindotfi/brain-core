"""Unit tests for the anomaly agent and its HTTP route."""

import json
from collections.abc import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from brain_agents.anomaly.agent import AnomalyAgent
from brain_agents.client import BrainApiClient
from brain_agents.deps import AppDeps
from brain_agents.payment.agent import PaymentAgent
from brain_agents.plaid_extractor.agent import PlaidExtractorAgent
from brain_agents.reconciliation.agent import ReconciliationAgent
from brain_agents.server import create_app


def _make_mock_deps() -> AppDeps:
    mock_anomaly: AsyncMock = AsyncMock(spec=AnomalyAgent)
    mock_anomaly.scan.return_value = {
        "kind": "anomaly_scan",
        "scanned": 2,
        "findings": [
            {
                "transaction_id": "tx_01",
                "category": "outlier_amount",
                "severity": "high",
                "rationale": "5x larger than the prior 30d average for this vendor.",
                "confidence": 0.88,
            }
        ],
        "summary": "1 outlier flagged out of 2 transactions.",
    }
    return AppDeps(
        brain_client=AsyncMock(spec=BrainApiClient),
        recon_agent=AsyncMock(spec=ReconciliationAgent),
        payment_agent=AsyncMock(spec=PaymentAgent),
        anomaly_agent=mock_anomaly,
        plaid_extractor_agent=MagicMock(spec=PlaidExtractorAgent),
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
# POST /run/anomaly route
# ---------------------------------------------------------------------------


async def test_anomaly_run_returns_findings(
    client: httpx.AsyncClient,
    mock_deps: AppDeps,
) -> None:
    resp = await client.post(
        "/run/anomaly",
        json={
            "agent_id": "agent_01TEST000000000000000000",
            "transactions": [
                {"id": "tx_01", "amount": "5000.00", "currency": "USD"},
                {"id": "tx_02", "amount": "12.34", "currency": "USD"},
            ],
            "tenant_id": "tnt_01TEST000000000000000000",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "anomaly_scan"
    assert body["scanned"] == 2
    assert len(body["findings"]) == 1
    assert body["findings"][0]["severity"] == "high"


async def test_anomaly_run_does_not_call_brain_propose(
    client: httpx.AsyncClient,
    mock_deps: AppDeps,
) -> None:
    """Anomaly findings are advisory; they must NEVER auto-trigger a proposal."""
    await client.post(
        "/run/anomaly",
        json={"agent_id": "agent_x", "transactions": [], "tenant_id": "tnt_x"},
    )
    mock_deps.anomaly_agent.scan.assert_awaited_once()  # type: ignore[union-attr]
    mock_deps.brain_client.propose.assert_not_awaited()  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# AnomalyAgent unit tests
# ---------------------------------------------------------------------------


async def test_agent_scan_always_carries_scanned_count() -> None:
    """The LLM occasionally omits `scanned`; the agent must reinsert it."""
    mock_openai = MagicMock()
    mock_openai.chat = MagicMock()
    mock_openai.chat.completions = MagicMock()
    mock_openai.chat.completions.create = AsyncMock(
        return_value=MagicMock(
            choices=[
                MagicMock(
                    message=MagicMock(
                        content=json.dumps(
                            {"findings": [], "summary": "Nothing suspicious."}
                            # Notice: no "scanned".
                        )
                    )
                )
            ]
        )
    )
    agent = AnomalyAgent(mock_openai, "gpt-4o-mini")
    result = await agent.scan([{"id": "t1"}, {"id": "t2"}, {"id": "t3"}])

    assert result["scanned"] == 3
    assert result["kind"] == "anomaly_scan"
    assert result["findings"] == []


async def test_agent_scan_handles_empty_llm_response() -> None:
    """Empty content ⇒ empty findings + summary, no crash."""
    mock_openai = MagicMock()
    mock_openai.chat = MagicMock()
    mock_openai.chat.completions = MagicMock()
    mock_openai.chat.completions.create = AsyncMock(
        return_value=MagicMock(choices=[MagicMock(message=MagicMock(content=None))])
    )
    agent = AnomalyAgent(mock_openai, "gpt-4o-mini")
    result = await agent.scan([{"id": "t1"}])
    assert result["scanned"] == 1
    assert result["findings"] == []
    assert result["summary"] == ""
