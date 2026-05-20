import type { AuditEmitter } from "@brain/shared";
import type { Pool } from "pg";
import type { AnchorBroadcaster } from "./publisher.js";

export interface AuditDeps {
  pool: Pool;
  audit: AuditEmitter;
  /** When set, enables POST /audit/anchor/publish (scope audit:admin). */
  broadcaster?: AnchorBroadcaster;
}
