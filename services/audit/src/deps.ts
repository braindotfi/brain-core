import type { AuditEmitter } from "@brain/api/shared";
import type { Pool } from "pg";

export interface AuditDeps {
  pool: Pool;
  audit: AuditEmitter;
}
