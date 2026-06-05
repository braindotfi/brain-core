"""Deterministic document content -> text for the document_extractor.

Turns the raw bytes of an uploaded financial document into plain text the
LLM extraction step can read. CSV and plain text decode directly (stdlib);
XLSX spreadsheets are read via openpyxl. PDF and image/OCR extraction are a
deferred follow-up (they need heavier deps and, for scans, a model step).

This step is deterministic on purpose: the only non-deterministic judgment in
the RFC 0004 pipeline is the LLM field extraction that runs on this text.
"""

import io
from typing import Final

from openpyxl import load_workbook

_CSV_MIMES: Final = frozenset({"text/csv", "application/csv"})
_XLSX_MIME: Final = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class UnsupportedDocumentTypeError(Exception):
    """Raised when a document's mime type has no deterministic text extractor."""

    def __init__(self, mime_type: str | None) -> None:
        super().__init__(f"no text extractor for mime type: {mime_type!r}")
        self.mime_type = mime_type


def extract_text(content: bytes, mime_type: str | None) -> str:
    """Return plain text for an uploaded document.

    Raises UnsupportedDocumentTypeError for formats without a deterministic
    extractor yet (e.g. application/pdf, images).
    """
    mime = (mime_type or "").split(";", 1)[0].strip().lower()
    if mime in _CSV_MIMES:
        return _decode(content)
    if mime == _XLSX_MIME:
        return _xlsx_to_text(content)
    # text/plain and friends; an empty/missing mime falls back to a utf-8 decode.
    if mime.startswith("text/") or mime == "":
        return _decode(content)
    raise UnsupportedDocumentTypeError(mime_type)


def _decode(content: bytes) -> str:
    return content.decode("utf-8", errors="replace")


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
