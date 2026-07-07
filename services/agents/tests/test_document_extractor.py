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
from brain_agents.document_extractor.agent import (
    DocumentExtractorAgent,
    DocumentOcrUnavailableError,
)
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


def _pdf_bytes(*page_texts: str) -> bytes:
    n_pages = len(page_texts)
    font_num = 3 + 2 * n_pages
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(n_pages))
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>".encode(),
    ]
    for i, text in enumerate(page_texts):
        stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode() if text else b""
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 {font_num} 0 R >> >> "
            f"/Contents {4 + 2 * i} 0 R >>".encode()
        )
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for num, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{num} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_at}\n%%EOF\n".encode()
    )
    return bytes(out)


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


async def test_run_ocr_extracts_image_bytes(
    client: httpx.AsyncClient,
    mock_deps: AppDeps,
) -> None:
    png_b64 = base64.b64encode(b"\x89PNG\r\n").decode("ascii")
    mock_deps.document_extractor_agent.ocr_text.return_value = (  # type: ignore[union-attr]
        "INVOICE\nAcme Utilities\nTotal due: 120.50"
    )

    resp = await client.post(
        "/run/document_extract",
        json={
            "agent_id": "agent_x",
            "tenant_id": "tnt_x",
            "raw_id": "raw_x",
            "document_b64": png_b64,
            "mime_type": "image/png",
        },
    )
    assert resp.status_code == 200
    mock_deps.document_extractor_agent.ocr_text.assert_awaited_once()  # type: ignore[union-attr]
    mock_deps.document_extractor_agent.extract.assert_awaited_once_with(  # type: ignore[union-attr]
        "INVOICE\nAcme Utilities\nTotal due: 120.50"
    )
    kwargs = mock_deps.brain_client.post_parsed.await_args.kwargs  # type: ignore[union-attr]
    assert kwargs["confidence"] == 0.5
    assert resp.json()["confidence"] == 0.5


async def test_run_ocr_extracts_scanned_pdf_bytes(
    client: httpx.AsyncClient,
    mock_deps: AppDeps,
) -> None:
    pdf_b64 = base64.b64encode(_pdf_bytes("")).decode("ascii")
    mock_deps.document_extractor_agent.ocr_text.return_value = (  # type: ignore[union-attr]
        "Rent statement\nAmount due 2200.00"
    )
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
    assert resp.status_code == 200
    mock_deps.document_extractor_agent.ocr_text.assert_awaited_once()  # type: ignore[union-attr]
    mock_deps.document_extractor_agent.extract.assert_awaited_once_with(  # type: ignore[union-attr]
        "Rent statement\nAmount due 2200.00"
    )


async def test_run_blank_ocr_fails_with_422(
    client: httpx.AsyncClient,
    mock_deps: AppDeps,
) -> None:
    png_b64 = base64.b64encode(b"\x89PNG\r\n").decode("ascii")
    mock_deps.document_extractor_agent.ocr_text.side_effect = (  # type: ignore[union-attr]
        DocumentOcrUnavailableError("OCR produced no usable text")
    )
    resp = await client.post(
        "/run/document_extract",
        json={
            "agent_id": "agent_x",
            "tenant_id": "tnt_x",
            "raw_id": "raw_x",
            "document_b64": png_b64,
            "mime_type": "image/png",
        },
    )
    assert resp.status_code == 422
    assert "OCR produced no usable text" in resp.json()["detail"]


async def test_run_rejects_textless_pdf_with_422(client: httpx.AsyncClient) -> None:
    # PDFs are a supported type now, but bytes without a readable text layer
    # (here: malformed) must still fail loudly rather than reach the LLM step.
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
    assert "no extractable text" in resp.json()["detail"]


async def test_run_does_not_ocr_malformed_pdf(
    client: httpx.AsyncClient,
    mock_deps: AppDeps,
) -> None:
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
    mock_deps.document_extractor_agent.ocr_text.assert_not_awaited()  # type: ignore[union-attr]


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


def _openai_ocr_returning(content: str) -> MagicMock:
    mock_openai = MagicMock()
    mock_openai.responses = MagicMock()
    mock_openai.responses.create = AsyncMock(return_value=MagicMock(output_text=content))
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


async def test_agent_ocr_image_uses_vision_model() -> None:
    mock_openai = _openai_ocr_returning("INVOICE\nAcme Utilities\nTotal due 120.50")
    agent = DocumentExtractorAgent(mock_openai, "gpt-4o-mini", ocr_model="gpt-4o")

    result = await agent.ocr_text(b"\x89PNG\r\n", "image/png")

    assert "Acme Utilities" in result
    mock_openai.responses.create.assert_awaited_once()
    kwargs = mock_openai.responses.create.await_args.kwargs
    assert kwargs["model"] == "gpt-4o"
    content = kwargs["input"][0]["content"]
    assert content[1]["type"] == "input_image"
    assert content[1]["image_url"].startswith("data:image/png;base64,")


async def test_agent_ocr_pdf_uses_file_input() -> None:
    mock_openai = _openai_ocr_returning("Rent statement\nAmount due 2200.00")
    agent = DocumentExtractorAgent(mock_openai, "gpt-4o-mini", ocr_model="gpt-4o")

    result = await agent.ocr_text(_pdf_bytes(""), "application/pdf")

    assert "Amount due" in result
    kwargs = mock_openai.responses.create.await_args.kwargs
    content = kwargs["input"][0]["content"]
    assert content[1]["type"] == "input_file"
    assert content[1]["file_data"].startswith("data:application/pdf;base64,")


async def test_agent_ocr_blank_output_raises() -> None:
    mock_openai = _openai_ocr_returning("   ")
    agent = DocumentExtractorAgent(mock_openai, "gpt-4o-mini", ocr_model="gpt-4o")

    with pytest.raises(DocumentOcrUnavailableError, match="OCR produced no usable text"):
        await agent.ocr_text(b"\x89PNG\r\n", "image/png")


async def test_agent_ocr_rejects_large_input_without_model_call() -> None:
    mock_openai = _openai_ocr_returning("text")
    agent = DocumentExtractorAgent(mock_openai, "gpt-4o-mini", ocr_model="gpt-4o")

    with pytest.raises(DocumentOcrUnavailableError, match="exceeds 10 MB"):
        await agent.ocr_text(b"x" * (10 * 1024 * 1024 + 1), "image/png")
    mock_openai.responses.create.assert_not_awaited()


async def test_agent_ocr_rejects_pdf_over_page_limit_without_model_call() -> None:
    mock_openai = _openai_ocr_returning("text")
    agent = DocumentExtractorAgent(mock_openai, "gpt-4o-mini", ocr_model="gpt-4o")

    with pytest.raises(DocumentOcrUnavailableError, match="exceeds 5 page limit"):
        await agent.ocr_text(_pdf_bytes("", "", "", "", "", ""), "application/pdf")
    mock_openai.responses.create.assert_not_awaited()
