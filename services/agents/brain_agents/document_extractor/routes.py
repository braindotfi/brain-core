"""POST /run/document_extract — extract an obligation from a document and
write it to Raw as a doc_obligation_v1 parsed record.

The route runs the (non-deterministic) extraction, then writes the result to
Raw via POST /raw/{id}/parsed. It never touches the Ledger directly: the
Ledger normalize step is what later promotes the parsed row into a candidate
obligation, capped at confidence <= 0.5 as agent-contributed evidence.
"""

import base64
import binascii
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from brain_agents.auth import require_inbound_auth
from brain_agents.deps import AppDeps, get_deps
from brain_agents.document_extractor.agent import DocumentOcrUnavailableError, OcrTextResult
from brain_agents.document_extractor.extract_text import (
    DocumentTextUnavailableError,
    UnsupportedDocumentTypeError,
    extract_text,
)

router = APIRouter(dependencies=[Depends(require_inbound_auth)])
_get_deps = Depends(get_deps)

_PARSER = "doc_obligation_v1"
_PARSER_VERSION = "1.0.0"


class DocumentExtractRequest(BaseModel):
    agent_id: str
    tenant_id: str
    # The raw_artifact id of the already-ingested document.
    raw_id: str
    # Provide exactly one source of content:
    #   - document_text: already-extracted plain text (back-compat / tests), or
    #   - document_b64: the raw artifact bytes, base64-encoded, which this route
    #     deterministically turns into text via extract_text() using mime_type.
    document_text: str | None = None
    document_b64: str | None = None
    mime_type: str | None = None


class DocumentExtractResult(BaseModel):
    kind: str
    raw_id: str
    parser: str
    parsed_id: str | None
    created: bool | None
    confidence: float


def _normalized_mime(mime_type: str | None) -> str:
    return (mime_type or "").split(";", 1)[0].strip().lower()


def _is_ocr_image_mime(mime_type: str | None) -> bool:
    return _normalized_mime(mime_type) in {"image/png", "image/jpeg", "image/jpg", "image/webp"}


def _is_scanned_pdf_error(mime_type: str | None, exc: DocumentTextUnavailableError) -> bool:
    return _normalized_mime(mime_type) == "application/pdf" and "no text layer" in exc.reason


async def _ocr_document_text(
    deps: AppDeps,
    content: bytes,
    mime_type: str | None,
) -> OcrTextResult:
    try:
        return await deps.document_extractor_agent.ocr_text(content, mime_type)
    except DocumentOcrUnavailableError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


async def _resolve_document_text(
    req: DocumentExtractRequest, deps: AppDeps
) -> tuple[str, float | None]:
    """Return the document text to extract from, or raise an HTTP error.

    Text extraction (bytes to text) is deterministic and preferred. OCR is used
    only for image inputs and PDFs whose text-layer extraction reports a scanned
    or image-only document.
    """
    if req.document_text is not None:
        return req.document_text, None
    if req.document_b64 is not None:
        try:
            content = base64.b64decode(req.document_b64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(status_code=400, detail="document_b64 is not valid base64") from exc
        try:
            return extract_text(content, req.mime_type), None
        except UnsupportedDocumentTypeError as exc:
            if _is_ocr_image_mime(req.mime_type):
                ocr = await _ocr_document_text(deps, content, req.mime_type)
                return ocr.text, ocr.confidence_cap
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except DocumentTextUnavailableError as exc:
            if _is_scanned_pdf_error(req.mime_type, exc):
                ocr = await _ocr_document_text(deps, content, req.mime_type)
                return ocr.text, ocr.confidence_cap
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    raise HTTPException(status_code=400, detail="provide document_text or document_b64")


@router.post("/run/document_extract", response_model=DocumentExtractResult)
async def run_document_extract(
    req: DocumentExtractRequest,
    deps: AppDeps = _get_deps,
) -> Any:
    document_text, confidence_cap = await _resolve_document_text(req, deps)
    extracted = await deps.document_extractor_agent.extract(document_text)
    confidence: float = (
        min(extracted["confidence"], confidence_cap)
        if confidence_cap is not None
        else extracted["confidence"]
    )

    result = await deps.brain_client.post_parsed(
        raw_id=req.raw_id,
        parser=_PARSER,
        parser_version=_PARSER_VERSION,
        extracted=extracted["payload"],
        confidence=confidence,
        tenant_id=req.tenant_id,
    )

    return DocumentExtractResult(
        kind="doc_extract",
        raw_id=req.raw_id,
        parser=_PARSER,
        parsed_id=result.get("id"),
        created=result.get("created"),
        confidence=confidence,
    )
