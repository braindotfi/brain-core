/**
 * Per-row quarantine for the canonical -> Ledger steady-state projection
 * workers (obligations.ts, accounts-transactions.ts).
 *
 * Mirrors the shape already established twice in this codebase for the exact
 * same problem: services/ledger/src/workers/normalizeWorker.ts's
 * normalization_log (attempts + quarantined, keyed by raw_parsed_id) and
 * services/canonical/src/projectors/worker.ts's canonical_projection_log. A
 * per-row failure is retried up to maxAttempts, then quarantined so the poll
 * excludes it and the rest of the batch (every other row, every other tenant)
 * keeps projecting.
 */

import type { Pool } from "pg";
import { withTenantScope, type MetricsEmitter } from "@brain/shared";

export const DEFAULT_MAX_PROJECTION_ATTEMPTS = 5;

export type ProjectionSourceTable =
  | "canonical_counterparty"
  | "canonical_obligation"
  | "canonical_account"
  | "canonical_transaction";

/** Record one row's projection outcome. Runs in its own tenant-scoped transaction. */
export async function recordProjectionResult(
  pool: Pool,
  sourceTable: ProjectionSourceTable,
  row: { id: string; tenant_id: string },
  errorMessage: string | null,
  opts?: { maxAttempts?: number },
): Promise<{ attempts: number; quarantined: boolean }> {
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_PROJECTION_ATTEMPTS;
  return withTenantScope(pool, row.tenant_id, async (c) => {
    const { rows } = await c.query<{ attempts: number; quarantined: boolean }>(
      `INSERT INTO ledger_projection_quarantine
         (source_table, source_id, tenant_id, error, attempts, quarantined, updated_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $4::text IS NULL THEN 0 ELSE 1 END, false, now())
       ON CONFLICT (source_table, source_id) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         error = EXCLUDED.error,
         attempts = CASE
           WHEN EXCLUDED.error IS NULL THEN 0
           ELSE ledger_projection_quarantine.attempts + 1
         END,
         quarantined = CASE
           WHEN EXCLUDED.error IS NULL THEN false
           ELSE (ledger_projection_quarantine.attempts + 1) >= $5
         END,
         updated_at = now()
       RETURNING attempts, quarantined`,
      [sourceTable, row.id, row.tenant_id, errorMessage, maxAttempts],
    );
    return rows[0] ?? { attempts: errorMessage === null ? 0 : 1, quarantined: false };
  });
}

/**
 * Run one row's projection, isolating a throw from `fn` to this row only:
 * records the failure (with bounded retry + quarantine), emits a metric on
 * the transition into quarantine, and returns undefined instead of
 * propagating. A caller-supplied `metricName` should be
 * `brain.ledger.<worker>.quarantined.count`.
 */
export async function projectRowWithQuarantine<T>(
  deps: { pool: Pool; metrics?: MetricsEmitter },
  sourceTable: ProjectionSourceTable,
  row: { id: string; tenant_id: string },
  metricName: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    const result = await fn();
    // Clear any prior failed/quarantined state now that the row projects clean.
    await recordProjectionResult(deps.pool, sourceTable, row, null).catch((err) =>
      console.error(`[ledgerProjection] failed to clear quarantine state for ${row.id}:`, err),
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ledgerProjection] ${sourceTable} projection failed for ${row.id}:`, message);
    try {
      const outcome = await recordProjectionResult(deps.pool, sourceTable, row, message);
      if (outcome.quarantined) {
        deps.metrics?.increment(metricName, {
          source_table: sourceTable,
          tenant_id: row.tenant_id,
        });
      }
    } catch (recordErr) {
      console.error(
        `[ledgerProjection] failed to write ledger_projection_quarantine for ${row.id}:`,
        recordErr,
      );
    }
    return undefined;
  }
}

/** SQL predicate excluding rows already quarantined for `sourceTable`. `idExpr` is the source row's id column, e.g. `co.id`. */
export function excludeQuarantined(sourceTable: ProjectionSourceTable, idExpr: string): string {
  return `NOT EXISTS (
            SELECT 1 FROM ledger_projection_quarantine lpq
             WHERE lpq.source_table = '${sourceTable}' AND lpq.source_id = ${idExpr} AND lpq.quarantined
          )`;
}
