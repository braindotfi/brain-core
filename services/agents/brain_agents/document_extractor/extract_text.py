"""Deterministic document content -> text for the document_extractor.

Turns the raw bytes of an uploaded financial document into plain text the
LLM extraction step can read. CSV and plain text decode directly (stdlib);
XLSX spreadsheets are read via openpyxl; PDFs with a text layer are read via
pypdf. Scanned/image-only PDFs and images are a deferred follow-up (OCR
needs a model step, which would break this step's determinism).

This step is deterministic on purpose: the only non-deterministic judgment in
the RFC 0004 pipeline is the LLM field extraction that runs on this text.
"""

import io
from typing import Final

from openpyxl import load_workbook
from pypdf import PdfReader
from pypdf.errors import PyPdfError

_CSV_MIMES: Final = frozenset({"text/csv", "application/csv"})
_XLSX_MIME: Final = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_PDF_MIME: Final = "application/pdf"


class UnsupportedDocumentTypeError(Exception):
    """Raised when a document's mime type has no deterministic text extractor."""

    def __init__(self, mime_type: str | None) -> None:
        super().__init__(f"no text extractor for mime type: {mime_type!r}")
        self.mime_type = mime_type


class DocumentTextUnavailableError(Exception):
    """Raised when a supported document type yields no extractable text.

    Covers malformed bytes, password-protected PDFs, and scanned/image-only
    PDFs (no text layer; would need OCR). Raising beats returning "" — empty
    text fed to the LLM extraction step invites hallucinated fields.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(f"no extractable text: {reason}")
        self.reason = reason


def extract_text(content: bytes, mime_type: str | None) -> str:
    """Return plain text for an uploaded document.

    Raises UnsupportedDocumentTypeError for formats without a deterministic
    extractor yet (e.g. images), and DocumentTextUnavailableError when a
    supported format carries no readable text (scanned/encrypted/broken PDF).
    """
    mime = (mime_type or "").split(";", 1)[0].strip().lower()
    if mime in _CSV_MIMES:
        return _decode(content)
    if mime == _XLSX_MIME:
        return _xlsx_to_text(content)
    if mime == _PDF_MIME:
        return _pdf_to_text(content)
    # text/plain and friends; an empty/missing mime falls back to a utf-8 decode.
    if mime.startswith("text/") or mime == "":
        return _decode(content)
    raise UnsupportedDocumentTypeError(mime_type)


def _decode(content: bytes) -> str:
    return content.decode("utf-8", errors="replace")


def _pdf_to_text(content: bytes) -> str:
    """Read a PDF's text layer, page by page.

    Encrypted PDFs get one empty-password attempt (common for "secured" but
    readable files); anything still locked, malformed, or text-free raises
    DocumentTextUnavailableError so the caller fails loudly instead of
    extracting obligations from a blank page.
    """
    try:
        reader = PdfReader(io.BytesIO(content))
        if reader.is_encrypted and not reader.decrypt(""):
            raise DocumentTextUnavailableError("PDF is password-protected")
        lines: list[str] = []
        for number, page in enumerate(reader.pages, start=1):
            text = page.extract_text()
            if text.strip():
                lines.append(f"# page: {number}")
                lines.append(text.strip())
        if not lines:
            raise DocumentTextUnavailableError(
                "PDF has no text layer (scanned/image-only documents need OCR, deferred)"
            )
        return "\n".join(lines)
    except PyPdfError as exc:
        raise DocumentTextUnavailableError(f"unreadable PDF: {exc}") from exc


def _xlsx_to_text(content: bytes) -> str:
    workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    try:
        lines: list[str] = []
        for sheet in workbook.worksheets:
            lines.append(f"# sheet: {sheet.title}")
            for row in sheet.iter_rows(values_only=True):
                cells = ["" if value is None else str(value) for value in row]
                if any(cell.strip() for cell in cells):
                    lines.append("\t".join(cells))
        return "\n".join(lines)
    finally:
        workbook.close()
