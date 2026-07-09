"""Document to doc_obligation_v1 extraction via OpenAI.

Given the text of an uploaded financial document (a bill, invoice, or
statement), the agent extracts the single obligation it represents and
returns a payload matching the Ledger `doc_obligation_v1` parser shape
(see services/ledger/src/extractors/doc-obligation.ts). This is the only
non-deterministic step in the RFC 0004 pipeline; everything downstream
(the Raw parsed write, the Ledger normalize, the §6 gate) is deterministic
and treats the result as low-confidence (<= 0.5) agent-contributed evidence.

The agent never calls the Ledger directly. Its output is written to Raw via
POST /raw/{id}/parsed by the route, preserving the layer boundary.
"""

import base64
import io
import json
from dataclasses import dataclass
from typing import Any, Final, cast

from openai import AsyncOpenAI
from pypdf import PdfReader
from pypdf.errors import PyPdfError

# Keys the Ledger doc_obligation_v1 parser understands. The model is asked
# to fill these; anything else it returns is dropped before the payload is
# written, so a chatty model cannot inject unexpected fields.
_PAYLOAD_KEYS = (
    "counterparty_name",
    "direction",
    "type",
    "amount",
    "currency",
    "due_date",
    "status",
    "minimum_due",
    "recurrence",
)

_MAX_OCR_BYTES: Final = 10 * 1024 * 1024
_MAX_OCR_PDF_PAGES: Final = 5
_OCR_TIMEOUT_SECONDS: Final = 30.0
_OCR_CONFIDENCE_CAP: Final = 0.5
_OCR_IMAGE_MIMES: Final = frozenset({"image/png", "image/jpeg", "image/jpg", "image/webp"})

_OCR_PROMPT: Final = """
Extract the visible text from this financial document image or scanned PDF.
Return only the text you can read. Preserve line breaks and numeric values.
Do not infer missing words, dates, amounts, vendors, or account numbers.
If there is no readable document text, return an empty string.
""".strip()

_SYSTEM_PROMPT = """
You extract a single financial obligation from the text of an uploaded
document (a bill, invoice, subscription notice, loan or rent statement).
Respond with ONLY a JSON object with these fields:

{
  "counterparty_name": "the other party (vendor we owe, or customer who owes us)",
  "direction": "payable" | "receivable",
  "type": "bill" | "invoice" | "subscription" | "loan" | "rent" | "payroll" | "tax" | "card_statement" | "other",
  "amount": "total amount due, as a plain decimal string e.g. \\"120.50\\"",
  "currency": "ISO 4217 code, 3 uppercase letters e.g. \\"USD\\"",
  "due_date": "ISO 8601 date-time e.g. \\"2026-07-01T00:00:00Z\\"",
  "status": "upcoming" | "due" | "paid" | "overdue" | "cancelled" | "disputed",
  "minimum_due": "optional minimum payment as a decimal string, omit if absent",
  "recurrence": "optional RFC 5545 RRULE or cron-ish string, omit if not recurring",
  "confidence": 0.0 to 1.0 — your confidence in the extraction
}

direction is "payable" when the document is a bill/invoice WE must pay, and
"receivable" when it is an invoice WE issued. Use "upcoming" for status when
the document does not state one. Respond with ONLY valid JSON.
""".strip()


@dataclass(frozen=True)
class OcrTextResult:
    text: str
    confidence_cap: float = _OCR_CONFIDENCE_CAP


class DocumentExtractorAgent:
    def __init__(self, client: AsyncOpenAI, model: str, *, ocr_model: str = "gpt-4o") -> None:
        self._client = client
        self._model = model
        self._ocr_model = ocr_model

    async def extract(self, document_text: str) -> dict[str, Any]:
        """Extract a doc_obligation_v1 payload + confidence from document text.

        Returns ``{"kind": "doc_obligation", "payload": {...}, "confidence": f}``.
        The payload contains only the keys the Ledger parser understands; the
        confidence is split out (default 0.5) so the caller can forward it to
        the raw_parsed write.
        """
        response = await self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": document_text},
            ],
            response_format={"type": "json_object"},
            temperature=0,
        )
        raw = response.choices[0].message.content or "{}"
        try:
            parsed: dict[str, Any] = json.loads(raw)
        except json.JSONDecodeError:
            parsed = {}

        confidence = _coerce_confidence(parsed.get("confidence"))
        payload = {k: parsed[k] for k in _PAYLOAD_KEYS if k in parsed and parsed[k] is not None}
        return {"kind": "doc_obligation", "payload": payload, "confidence": confidence}

    async def ocr_text(self, content: bytes, mime_type: str | None) -> OcrTextResult:
        """Use a vision model to recover text from an image or scanned PDF.

        Deterministic text extraction is preferred by the route. This method is
        only for image inputs and PDFs that have already been found to have no
        text layer. The output is model-generated text, so the returned contract
        carries the downstream confidence cap that quarantines OCR evidence.
        """
        mime = _normalize_mime(mime_type)
        _guard_ocr_size(content)
        if mime in _OCR_IMAGE_MIMES:
            input_part: dict[str, Any] = {
                "type": "input_image",
                "image_url": _data_url(mime, content),
                "detail": "high",
            }
        elif mime == "application/pdf":
            _guard_pdf_pages(content)
            input_part = {
                "type": "input_file",
                "filename": "document.pdf",
                "file_data": _data_url(mime, content),
                "detail": "high",
            }
        else:
            raise DocumentOcrUnavailableError(f"OCR unsupported for mime type: {mime_type!r}")

        response = await self._client.responses.create(
            model=self._ocr_model,
            input=cast(
                Any,
                [
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": _OCR_PROMPT},
                            input_part,
                        ],
                    }
                ],
            ),
            temperature=0,
            max_output_tokens=2000,
            timeout=_OCR_TIMEOUT_SECONDS,
        )
        text = str(getattr(response, "output_text", "") or "").strip()
        if not text:
            raise DocumentOcrUnavailableError("OCR produced no usable text")
        return OcrTextResult(text=text)


class DocumentOcrUnavailableError(Exception):
    """Raised when OCR cannot safely provide usable document text."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"no extractable text: {reason}")
        self.reason = reason


def _coerce_confidence(value: Any) -> float:
    """Clamp a model-provided confidence into [0, 1]; default 0.5 when absent."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return max(0.0, min(1.0, float(value)))
    return 0.5


def _normalize_mime(mime_type: str | None) -> str:
    return (mime_type or "").split(";", 1)[0].strip().lower()


def _data_url(mime_type: str, content: bytes) -> str:
    encoded = base64.b64encode(content).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _guard_ocr_size(content: bytes) -> None:
    if len(content) > _MAX_OCR_BYTES:
        raise DocumentOcrUnavailableError(
            f"OCR input exceeds {_MAX_OCR_BYTES // (1024 * 1024)} MB limit"
        )


def _guard_pdf_pages(content: bytes) -> None:
    try:
        reader = PdfReader(io.BytesIO(content))
        if reader.is_encrypted:
            raise DocumentOcrUnavailableError("OCR PDF is password-protected")
        page_count = len(reader.pages)
    except PyPdfError as exc:
        raise DocumentOcrUnavailableError(f"OCR PDF is unreadable: {exc}") from exc
    if page_count > _MAX_OCR_PDF_PAGES:
        raise DocumentOcrUnavailableError(
            f"OCR PDF exceeds {_MAX_OCR_PDF_PAGES} page limit ({page_count} pages)"
        )
