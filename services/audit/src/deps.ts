import type { AuditEmitter } from "@brain/shared";
import type { Pool } from "pg";

export interface AuditDeps {
  pool: Pool;
  audit: AuditEmitter;
}
