"""Unit tests for deterministic document -> text extraction (RFC 0004)."""

import io

import pytest
from openpyxl import Workbook

from brain_agents.document_extractor.extract_text import (
    UnsupportedDocumentTypeError,
    extract_text,
)


def _xlsx_bytes() -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Invoice"
    sheet.append(["Vendor", "Amount", "Due"])
    sheet.append(["Acme Utilities", 120.50, "2026-07-01"])
    sheet.append([None, None, None])  # blank row is skipped
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def test_extract_text_decodes_csv() -> None:
    content = b"vendor,amount,due\nAcme Utilities,120.50,2026-07-01\n"
    out = extract_text(content, "text/csv")
    assert "Acme Utilities" in out
    assert "120.50" in out


def test_extract_text_decodes_plain_text() -> None:
    out = extract_text(b"INVOICE\nTotal due: 120.50", "text/plain")
    assert "Total due: 120.50" in out


def test_extract_text_strips_charset_param_from_mime() -> None:
    out = extract_text(b"hello", "text/plain; charset=utf-8")
    assert out == "hello"


def test_extract_text_empty_mime_falls_back_to_utf8() -> None:
    assert extract_text(b"plain bytes", None) == "plain bytes"


def test_extract_text_reads_xlsx_cells() -> None:
    out = extract_text(
        _xlsx_bytes(),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    assert "# sheet: Invoice" in out
    assert "Acme Utilities" in out
    assert "120.5" in out
    # blank trailing row must not produce an empty tab-joined line
    assert "\n\t\t\n" not in out


def test_extract_text_rejects_unsupported_type() -> None:
    with pytest.raises(UnsupportedDocumentTypeError) as exc:
        extract_text(b"%PDF-1.7", "application/pdf")
    assert exc.value.mime_type == "application/pdf"
