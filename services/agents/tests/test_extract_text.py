"""Unit tests for deterministic document -> text extraction (RFC 0004)."""

import io

import pytest
from openpyxl import Workbook
from pypdf import PdfReader, PdfWriter

from brain_agents.document_extractor.extract_text import (
    DocumentTextUnavailableError,
    UnsupportedDocumentTypeError,
    extract_text,
)


def _pdf_bytes(*page_texts: str) -> bytes:
    """Build a minimal valid PDF (one Helvetica line per page), stdlib-only.

    An empty string produces a page with no text operators — the shape of a
    scanned/image-only page. Texts must not contain parentheses (unescaped
    PDF string literals).
    """
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


def _encrypted_pdf_bytes(user_password: str) -> bytes:
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(_pdf_bytes("Confidential invoice"))))
    writer.encrypt(user_password=user_password, owner_password="owner-secret", algorithm="RC4-128")
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


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


def test_extract_text_reads_pdf_text_layer() -> None:
    out = extract_text(
        _pdf_bytes("INVOICE 4411 Acme Utilities total due 120.50"), "application/pdf"
    )
    assert "# page: 1" in out
    assert "Acme Utilities" in out
    assert "120.50" in out


def test_extract_text_pdf_marks_pages_and_skips_blank_ones() -> None:
    out = extract_text(_pdf_bytes("Page one terms", "", "Remit to Acme"), "application/pdf")
    assert "# page: 1" in out
    assert "# page: 3" in out
    assert "# page: 2" not in out  # no text layer on page 2 — no empty marker
    assert out.index("Page one terms") < out.index("Remit to Acme")


def test_extract_text_pdf_without_text_layer_raises() -> None:
    with pytest.raises(DocumentTextUnavailableError, match="no text layer"):
        extract_text(_pdf_bytes(""), "application/pdf")


def test_extract_text_malformed_pdf_raises() -> None:
    with pytest.raises(DocumentTextUnavailableError, match="unreadable PDF"):
        extract_text(b"%PDF-1.7 not actually a pdf", "application/pdf")


def test_extract_text_password_protected_pdf_raises() -> None:
    with pytest.raises(DocumentTextUnavailableError, match="password-protected"):
        extract_text(_encrypted_pdf_bytes("hunter2"), "application/pdf")


def test_extract_text_empty_user_password_pdf_decrypts() -> None:
    # "Secured" PDFs with an owner password but empty user password are readable.
    out = extract_text(_encrypted_pdf_bytes(""), "application/pdf")
    assert "Confidential invoice" in out


def test_extract_text_rejects_unsupported_type() -> None:
    with pytest.raises(UnsupportedDocumentTypeError) as exc:
        extract_text(b"\x89PNG\r\n", "image/png")
    assert exc.value.mime_type == "image/png"
