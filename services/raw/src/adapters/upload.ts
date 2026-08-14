/**
 * File-upload adapters. The caller provides the bytes via multipart form
 * data; these adapters are no-op transformers.
 *
 * Named upload types are document-tier connector types from the ingestion
 * architecture (Appendix A connector 6). Arbitrary other files land as
 * `other` via the universal fallback adapter in `stubs.ts`.
 */

import type { SourceAdapter } from "./types.js";

export const CsvUploadAdapter: SourceAdapter = {
  sourceType: "csv_upload",
};

export const XlsxUploadAdapter: SourceAdapter = {
  sourceType: "xlsx_upload",
};

export const TxtUploadAdapter: SourceAdapter = {
  sourceType: "txt_upload",
};

export const PdfUploadAdapter: SourceAdapter = {
  sourceType: "pdf_upload",
};
