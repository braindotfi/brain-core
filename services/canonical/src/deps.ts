import type { Pool } from "pg";

/** Dependencies for the canonical read API (Phase 6 governed data products). */
export interface CanonicalDeps {
  pool: Pool;
}
