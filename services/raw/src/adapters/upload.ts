/**
 * Generic upload adapter. The caller provides the bytes via multipart form
 * data; this adapter is a no-op transformer.
 */

import type { SourceAdapter } from "./types.js";

export const UploadAdapter: SourceAdapter = {
  sourceType: "upload",
};
