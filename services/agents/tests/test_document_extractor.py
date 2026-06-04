"""Unit tests for the document_extractor agent and its HTTP route."""

import base64
import json
from collections.abc import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from brain_agents.anomaly.agent import AnomalyAgent
from brain_agents.client import BrainApiClient
from brain_agents.deps import AppDeps
from brain_agents.document_extractor.agent import DocumentExtractorAgent
from brain_agents.payment.agent import PaymentAgent
from brain_agents.plaid_extractor.agent import PlaidExtractorAgent
from brain_agents.reconciliation.agent import ReconciliationAgent
from brain_agents.server import create_app

_PAYLOAD = {
    "counterparty_name": "Acme Utilities",
    "direction": "payable",
    "type": "bill",
    "amount": "120.50",
    "currency": "USD",
    "due_date": "2026-07-01T00:00:00Z",
    "status": "upcoming",
}


def _make_mock_deps() -> AppDeps:
    mock_doc: AsyncMock = AsyncMock(spec=DocumentExtractorAgent)
    mock_doc.extract.return_value = {
        "kind": "doc_obligation",
        "payload": _PAYLOAD,
        "confidence": 0.8,
    }
    mock_brain: AsyncMock = AsyncMock(spec=BrainApiClient)
    mock_brain.post_parsed.return_value = {"id": "prs_01TEST", "created": True}
    return AppDeps(
        brain_client=mock_brain,
        recon_agent=AsyncMock(spec=ReconciliationAgent),
        payment_agent=AsyncMock(spec=PaymentAgent),
        anomaly_agent=AsyncMock(spec=AnomalyAgent),
        plaid_extractor_agent=MagicMock(spec=PlaidExtractorAgent),
        document_extractor_agent=mock_doc,
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
# POST /run/document_extract route
# ---------------------------------------------------------------------------


async def test_run_writes_parsed_record_and_returns_result(
    client: httpx.AsyncClient,
    mock_deps: AppDeps,
) -> None:
    resp = await client.post(
        "/run/document_extract",
        json={
            "agent_id": "agent_01TEST000000000000000000",
            "tenant_id": "tnt_01TEST000000000000000000",
            "raw_id": "raw_01TEST000000000000000000",
            "document_text": "INVOICE\nAcme Utilities\nTotal due: $120.50\nDue: 2026-07-01",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "doc_extract"
    assert body["parser"] == "doc_obligation_v1"
    assert body["parsed_id"] == "prs_01TEST"
    assert body["created"] is True
    assert body["confidence"] == 0.8

    # The route must write to Raw with the parser tuple + extracted payload,
    # and must NOT call propose (extraction never moves money).
    mock_deps.brain_client.post_parsed.assert_awaited_once()  # type: ignore[union-attr]
    kwargs = mock_deps.brain_client.post_parsed.await_args.kwargs  # type: ignore[union-attr]
    assert kwargs["parser"] == "doc_obligation_v1"
    assert kwargs["parser_version"] == "1.0.0"
    assert kwargs["extracted"] == _PAYLOAD
    assert kwargs["confidence"] == 0.8
    mock_deps.brain_client.propose.assert_not_awaited()  # type: ignore[union-attr]


async def test_run_extracts_text_from_base64_csv_bytes(
    client: httpx.AsyncClient,
    mock_deps: AppDeps,
) -> None:
    csv_b64 = base64.b64encode(b"vendor,amount\nAcme,120.50\n").decode("ascii")
    resp = await client.post(
        "/run/document_extract",
        json={
            "agent_id": "agent_x",
            "tenant_id": "tnt_x",
            "raw_id": "raw_x",
            "document_b64": csv_b64,
            "mime_type": "text/csv",
        },
    )
    assert resp.status_code == 200
    # The agent must receive the DECODED document text, not the base64.
    mock_deps.document_extractor_agent.extract.assert_awaited_once()  # type: ignore[union-attr]
    (text_arg,) = mock_deps.document_extractor_agent.extract.await_args.args  # type: ignore[union-attr]
    assert "Acme" in text_arg


async def test_run_rejects_unsupported_mime_with_422(client: httpx.AsyncClient) -> None:
    pdf_b64 = base64.b64encode(b"%PDF-1.7 ...").decode("ascii")
    resp = await client.post(
        "/run/document_extract",
        json={
            "agent_id": "agent_x",
            "tenant_id": "tnt_x",
            "raw_id": "raw_x",
            "document_b64": pdf_b64,
            "mime_type": "application/pdf",
        },
    )
    assert resp.status_code == 422


async def test_run_requires_a_content_source_400(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/run/document_extract",
        json={"agent_id": "agent_x", "tenant_id": "tnt_x", "raw_id": "raw_x"},
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# DocumentExtractorAgent unit tests
# ---------------------------------------------------------------------------


def _openai_returning(content: str | None) -> MagicMock:
    mock_openai = MagicMock()
    mock_openai.chat = MagicMock()
    mock_openai.chat.completions = MagicMock()
    mock_openai.chat.completions.create = AsyncMock(
        return_value=MagicMock(choices=[MagicMock(message=MagicMock(content=content))])
    )
    return mock_openai


async def test_agent_extract_splits_payload_and_confidence() -> None:
    mock_openai = _openai_returning(json.dumps({**_PAYLOAD, "confidence": 0.9}))
    agent = DocumentExtractorAgent(mock_openai, "gpt-4o-mini")
    result = await agent.extract("some invoice text")

    assert result["kind"] == "doc_obligation"
    assert result["confidence"] == 0.9
    # confidence must be stripped out of the payload that goes to the Ledger parser
    assert "confidence" not in result["payload"]
    assert result["payload"]["counterparty_name"] == "Acme Utilities"


async def test_agent_extract_drops_unknown_keys() -> None:
    mock_openai = _openai_returning(
        json.dumps({**_PAYLOAD, "chatty_field": "ignore me", "confidence": 0.7})
    )
    agent = DocumentExtractorAgent(mock_openai, "gpt-4o-mini")
    result = await agent.extract("text")
    assert "chatty_field" not in result["payload"]


async def test_agent_extract_defaults_confidence_when_missing() -> None:
    mock_openai = _openai_returning(json.dumps(_PAYLOAD))  # no confidence field
    agent = DocumentExtractorAgent(mock_openai, "gpt-4o-mini")
    result = await agent.extract("text")
    assert result["confidence"] == 0.5


async def test_agent_extract_handles_non_json_response() -> None:
    mock_openai = _openai_returning("not json at all")
    agent = DocumentExtractorAgent(mock_openai, "gpt-4o-mini")
    result = await agent.extract("text")
    assert result["payload"] == {}
    assert result["confidence"] == 0.5


async def test_agent_extract_clamps_out_of_range_confidence() -> None:
    mock_openai = _openai_returning(json.dumps({**_PAYLOAD, "confidence": 5}))
    agent = DocumentExtractorAgent(mock_openai, "gpt-4o-mini")
    result = await agent.extract("text")
    assert result["confidence"] == 1.0
