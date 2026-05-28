"""Unit tests for the payment agent and its HTTP route."""

import json
from collections.abc import AsyncGenerator
from typing import Any
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

MOCK_PROPOSAL: dict[str, Any] = {
    "id": "prop_01TEST000000000000000000000",
    "proposing_agent_id": "agent_01TEST000000000000000000",
    "action": {
        "kind": "payment",
        "action_type": "ach_outbound",
        "amount": "1234.56",
        "currency": "USD",
    },
    "policy_decision_id": "dec_01TEST000000000000000000000",
    "status": "pending",
    "approvers_signed": [],
    "created_at": "2025-01-01T00:00:00Z",
}


def _make_mock_deps() -> AppDeps:
    mock_payment: AsyncMock = AsyncMock(spec=PaymentAgent)
    mock_payment.propose.return_value = {
        "kind": "payment",
        "action_type": "ach_outbound",
        "source_account_id": "acc_01AP000000000000000000000",
        "destination_counterparty_id": "cp_01VENDOR0000000000000000",
        "amount": "1234.56",
        "currency": "USD",
        "rationale": "Pays invoice INV-42 in full.",
        "confidence": 0.97,
    }
    mock_brain: AsyncMock = AsyncMock(spec=BrainApiClient)
    mock_brain.propose.return_value = MOCK_PROPOSAL
    return AppDeps(
        brain_client=mock_brain,
        recon_agent=AsyncMock(spec=ReconciliationAgent),
        payment_agent=mock_payment,
        anomaly_agent=AsyncMock(spec=AnomalyAgent),
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
# POST /run/payment route
# ---------------------------------------------------------------------------


async def test_payment_run_returns_proposal(
    client: httpx.AsyncClient,
    mock_deps: AppDeps,
) -> None:
    resp = await client.post(
        "/run/payment",
        json={
            "agent_id": "agent_01TEST000000000000000000",
            "context": {"invoice_id": "inv_01INV0000000000000000000", "amount_due": "1234.56"},
            "tenant_id": "tnt_01TEST000000000000000000",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == MOCK_PROPOSAL["id"]
    mock_deps.payment_agent.propose.assert_awaited_once()  # type: ignore[union-attr]
    mock_deps.brain_client.propose.assert_awaited_once()  # type: ignore[union-attr]


async def test_payment_run_missing_agent_id_returns_422(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/run/payment",
        json={"context": {}, "tenant_id": "tnt_x"},
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# PaymentAgent unit tests — invariant: linkage fields survive the LLM merge
# ---------------------------------------------------------------------------


async def test_agent_propose_preserves_linkage_ids() -> None:
    """invoice_id / obligation_id / evidence_ids from input MUST round-trip.

    The gate uses them for check 9.5 (evidence-semantic validation) and check
    11.5 (duplicate-payment guard), so silently dropping them would break the
    deterministic preconditions.
    """
    mock_openai = MagicMock()
    mock_openai.chat = MagicMock()
    mock_openai.chat.completions = MagicMock()
    mock_openai.chat.completions.create = AsyncMock(
        return_value=MagicMock(
            choices=[
                MagicMock(
                    message=MagicMock(
                        content=json.dumps(
                            {
                                "action_type": "ach_outbound",
                                "source_account_id": "acc_x",
                                "destination_counterparty_id": "cp_y",
                                "amount": "100.00",
                                "currency": "USD",
                                "rationale": "test",
                                "confidence": 0.9,
                                # Notice: LLM did NOT echo the linkage fields.
                            }
                        )
                    )
                )
            ]
        )
    )
    agent = PaymentAgent(mock_openai, "gpt-4o-mini")
    context = {
        "invoice_id": "inv_42",
        "obligation_id": "obl_7",
        "evidence_ids": ["raw_1", "raw_2"],
    }
    result = await agent.propose(context)

    assert result["invoice_id"] == "inv_42"
    assert result["obligation_id"] == "obl_7"
    assert result["evidence_ids"] == ["raw_1", "raw_2"]
    assert result["kind"] == "payment"
    assert result["action_type"] == "ach_outbound"


async def test_agent_propose_handles_empty_llm_response() -> None:
    """Empty LLM content does not crash; linkage fields still preserved."""
    mock_openai = MagicMock()
    mock_openai.chat = MagicMock()
    mock_openai.chat.completions = MagicMock()
    mock_openai.chat.completions.create = AsyncMock(
        return_value=MagicMock(choices=[MagicMock(message=MagicMock(content=None))])
    )
    agent = PaymentAgent(mock_openai, "gpt-4o-mini")
    result = await agent.propose({"invoice_id": "inv_99"})
    assert result["invoice_id"] == "inv_99"
    assert result["kind"] == "payment"
