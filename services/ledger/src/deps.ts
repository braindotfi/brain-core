import type { AuditEmitter } from "@brain/api/shared";
import type { Pool } from "pg";

export interface LedgerDeps {
  pool: Pool;
  audit: AuditEmitter;
}
