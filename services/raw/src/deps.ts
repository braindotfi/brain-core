/**
 * Raw service dependency bundle.
 *
 * Packed for injection into the route registrars and ingest orchestrator.
 * The server.ts boot code constructs the bundle once and passes it down.
 */

import type { AuditEmitter, BlobAdapter } from "@brain/shared";
import type { Pool } from "pg";

export interface RawDeps {
  pool: Pool;
  blob: BlobAdapter;
  audit: AuditEmitter;
  extractionJobs?: {
    documentExtractorConfigured: boolean;
  };
}
