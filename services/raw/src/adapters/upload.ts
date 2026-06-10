/**
 * File-upload adapters. The caller provides the bytes via multipart form
 * data; these adapters are no-op transformers.
 *
 * `csv_upload` and `pdf_upload` are the named document-tier connector types
 * from the ingestion architecture (Appendix A connector 6); arbitrary other
 * files land as `other` via the universal fallback adapter in `stubs.ts`.
 */

import type { SourceAdapter } from "./types.js";

export const CsvUploadAdapter: SourceAdapter = {
  sourceType: "csv_upload",
};

export const PdfUploadAdapter: SourceAdapter = {
  sourceType: "pdf_upload",
};
