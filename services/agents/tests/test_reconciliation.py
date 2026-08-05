"""Unit tests for the reconciliation agent and its HTTP route."""

import json
from collections.abc import AsyncGenerator
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
import respx

from brain_agents.anomaly.agent import AnomalyAgent
from brain_agents.client import BrainApiClient, TenantBindingUnavailableError
from brain_agents.deps import AppDeps
from brain_agents.document_extractor.agent import DocumentExtractorAgent
from brain_agents.plaid_extractor.agent import PlaidExtractorAgent
from brain_agents.reconciliation.agent import ReconciliationAgent
from brain_agents.server import create_app

MOCK_PROPOSAL: dict[str, Any] = {
    "id": "prop_01TEST000000000000000000000",
    "proposing_agent_id": "agent_01TEST000000000000000000",
    "action": {"kind": "reconciliation", "matches": [], "confidence": 0.9},
    "policy_decision_id": "dec_01TEST000000000000000000000",
    "status": "pending",
    "approvers_signed": [],
    "created_at": "2025-01-01T00:00:00Z",
}


def _make_mock_deps() -> AppDeps:
    mock_recon: AsyncMock = AsyncMock(spec=ReconciliationAgent)
    mock_recon.analyze.return_value = {
        "kind": "reconciliation",
        "matches": [],
        "discrepancies": [],
        "confidence": 0.9,
        "summary": "No transactions to reconcile.",
    }
    mock_brain: AsyncMock = AsyncMock(spec=BrainApiClient)
    mock_brain.propose.return_value = MOCK_PROPOSAL
    return AppDeps(
        brain_client=mock_brain,
        recon_agent=mock_recon,
        anomaly_agent=AsyncMock(spec=AnomalyAgent),
        plaid_extractor_agent=MagicMock(spec=PlaidExtractorAgent),
        document_extractor_agent=AsyncMock(spec=DocumentExtractorAgent),
    )


@pytest.fixture
def mock_deps() -> AppDeps:
    return _make_mock_deps()


@pytest.fixture
async def client(mock_deps: AppDeps) -> AsyncGenerator[httpx.AsyncClient, None]:
    # ASGITransport does not fire the ASGI lifespan; set state directly.
    app = create_app(deps=mock_deps)
    app.state.deps = mock_deps
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),  # type: ignore[arg-type]
        base_url="http://test",
    ) as c:
        yield c


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------


async def test_health(client: httpx.AsyncClient) -> None:
    resp = await client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["service"] == "brain-agents"


# ---------------------------------------------------------------------------
# POST /run/reconciliation — happy path
# ---------------------------------------------------------------------------


async def test_reconciliation_run_returns_proposal(
    client: httpx.AsyncClient,
    mock_deps: AppDeps,
) -> None:
    resp = await client.post(
        "/run/reconciliation",
        json={
            "agent_id": "agent_01TEST000000000000000000",
            "action": {"kind": "reconciliation", "period_start": "2025-01-01"},
            "tenant_id": "tnt_01TEST000000000000000000",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == MOCK_PROPOSAL["id"]
    assert body["status"] == "pending"


async def test_reconciliation_run_calls_analyze_then_propose(
    client: httpx.AsyncClient,
    mock_deps: AppDeps,
) -> None:
    """Verifies the route calls recon_agent.analyze before brain_client.propose."""
    await client.post(
        "/run/reconciliation",
        json={
            "agent_id": "agent_01TEST000000000000000000",
            "action": {"kind": "reconciliation"},
            "tenant_id": "tnt_01TEST000000000000000000",
        },
    )
    mock_deps.recon_agent.analyze.assert_awaited_once()  # type: ignore[union-attr]
    mock_deps.brain_client.propose.assert_awaited_once()  # type: ignore[union-attr]


async def test_reconciliation_run_missing_agent_id(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.post(
        "/run/reconciliation",
        json={"action": {"kind": "reconciliation"}, "tenant_id": "tnt_x"},
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# ReconciliationAgent unit tests
# ---------------------------------------------------------------------------


def _openai_returning(content: str | None) -> MagicMock:
    mock_openai = MagicMock()
    mock_openai.chat = MagicMock()
    mock_openai.chat.completions = MagicMock()
    mock_openai.chat.completions.create = AsyncMock(
        return_value=MagicMock(choices=[MagicMock(message=MagicMock(content=content))])
    )
    return mock_openai


async def test_agent_analyze_preserves_kind() -> None:
    """kind and other caller-set fields must survive the LLM merge. The
    model's own "confidence" claim is not an allowlisted contribution (see
    _MODEL_CONTRIBUTED_FIELDS / RFC F1) and must not appear."""
    mock_openai = _openai_returning(
        json.dumps(
            {
                "matches": [],
                "discrepancies": [],
                "confidence": 0.85,
                "summary": "All clear.",
            }
        )
    )
    agent = ReconciliationAgent(mock_openai, "gpt-4o-mini")
    action = {"kind": "reconciliation", "period": "2025-01"}
    result = await agent.analyze(action)

    assert result["kind"] == "reconciliation"
    assert result["period"] == "2025-01"
    assert result["summary"] == "All clear."
    assert "confidence" not in result


async def test_agent_analyze_handles_empty_llm_response() -> None:
    """Empty LLM content falls back to empty dict merge — kind still preserved."""
    mock_openai = _openai_returning(None)
    agent = ReconciliationAgent(mock_openai, "gpt-4o-mini")
    result = await agent.analyze({"kind": "reconciliation"})
    assert result["kind"] == "reconciliation"


@pytest.mark.parametrize("gate_field", ["confidence", "evidence_score", "risk_level"])
async def test_agent_analyze_model_cannot_override_gate_read_fields(gate_field: str) -> None:
    """RFC F1 regression. The section 6 policy VM reads confidence /
    evidence_score / risk_level straight off the stored action
    (services/policy/src/vm.ts). A model response that sets any of these
    must never survive the merge -- the deterministic value the caller
    already computed must win. This must fail against pre-fix agent.py
    (`{**action, **enriched, ...}` lets the model's value win)."""
    mock_openai = _openai_returning(json.dumps({gate_field: "attacker-controlled", "matches": []}))
    agent = ReconciliationAgent(mock_openai, "gpt-4o-mini")
    action = {"kind": "reconciliation", gate_field: 0.31}
    result = await agent.analyze(action)
    assert result[gate_field] == 0.31


async def test_agent_analyze_drops_gate_read_fields_the_model_invents() -> None:
    """Even when the deterministic action never set the field at all, the
    model must not be able to introduce it -- allowlist, not denylist."""
    mock_openai = _openai_returning(json.dumps({"confidence": 1.0, "risk_level": "low"}))
    agent = ReconciliationAgent(mock_openai, "gpt-4o-mini")
    result = await agent.analyze({"kind": "reconciliation"})
    assert "confidence" not in result
    assert "risk_level" not in result


# ---------------------------------------------------------------------------
# BrainApiClient unit test
# ---------------------------------------------------------------------------


async def test_brain_client_calls_correct_endpoint() -> None:
    """Verifies the client hits /v1/execution/propose with the right body."""
    with respx.mock() as mock:
        mock.post("http://localhost:3001/v1/execution/propose").respond(200, json=MOCK_PROPOSAL)
        api_client = BrainApiClient("http://localhost:3001", "test-token", "shared-secret")
        result = await api_client.propose(
            {"kind": "reconciliation"}, "agent_01TEST", "tnt_01TEST000000000000000000"
        )

    assert result["id"] == MOCK_PROPOSAL["id"]


async def test_brain_client_propose_fails_closed_without_service_secret() -> None:
    """RFC F2 regression: propose() must refuse to run rather than default to
    the static token's own tenant when it cannot prove the tenant binding."""
    api_client = BrainApiClient("http://localhost:3001", "test-token")
    with pytest.raises(TenantBindingUnavailableError):
        await api_client.propose({"kind": "reconciliation"}, "agent_01TEST", "tnt_x")
