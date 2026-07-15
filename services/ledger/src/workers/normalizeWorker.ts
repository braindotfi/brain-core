/**
 * Normalization worker.
 *
 * Polls raw_parsed for rows whose parser is registered in the extractor
 * registry (extractors/registry.ts) and that have not yet been promoted to
 * Ledger entities, then calls LedgerService.normalizeFromRaw for each one.
 * Uses normalization_log (Ledger-owned) to track state so repeated runs are
 * idempotent.
 *
 * The poll is generic over the registry (Appendix B mechanism 2): registering
 * a new parser requires no change here; the worker picks it up on the next
 * cycle.
 *
 * The polling query reads raw_parsed cross-service (the same controlled
 * exception documented in LedgerService.normalizeFromRaw). In production
 * the DB user must have BYPASSRLS or superuser privileges for the cross-
 * tenant poll query; the actual normalization runs per-tenant via
 * withTenantScope.
 */

import type { Pool } from "pg";
import {
  startManagedInterval,
  leasedCycle,
  withTenantScope,
  type AuditEmitter,
  type MetricsEmitter,
} from "@brain/shared";
import type { ManagedWorker } from "@brain/shared";
import { LedgerService } from "../service/LedgerService.js";
import { registeredParsers } from "../extractors/registry.js";
import type { LedgerDeps } from "../deps.js";

export const DEFAULT_MAX_NORMALIZATION_ATTEMPTS = 5;

interface PendingNormalizeRow {
  id: string;
  tenant_id: string;
  parser: string;
}

export interface NormalizeCycleDeps {
  pool: Pool;
  audit?: AuditEmitter;
  metrics?: MetricsEmitter;
  normalizeRow?: (row: PendingNormalizeRow, actor: string) => Promise<void>;
}

/**
 * Record the per-row normalization outcome. The cross-tenant poll uses the
 * privileged pool, but this write is tenant-specific, so route it through
 * withTenantScope: it sets app.tenant_id so the RLS WITH CHECK constraint
 * engages (a no-op under a BYPASSRLS role, but a real safety net if the worker
 * ever runs under the non-bypass brain_app role).
 */
export async function recordNormalizationResult(
  pool: Pool,
  row: { id: string; tenant_id: string; parser: string },
  errorMessage: string | null,
  opts?: { maxAttempts?: number },
): Promise<{ attempts: number; quarantined: boolean }> {
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_NORMALIZATION_ATTEMPTS;
  return withTenantScope(pool, row.tenant_id, async (c) => {
    const { rows } = await c.query<{ attempts: number; quarantined: boolean }>(
      `INSERT INTO normalization_log
         (raw_parsed_id, tenant_id, parser, normalized_at, error, attempts, quarantined)
       VALUES ($1, $2, $3, now(), $4, CASE WHEN $4::text IS NULL THEN 0 ELSE 1 END, false)
       ON CONFLICT (raw_parsed_id) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         parser = EXCLUDED.parser,
         normalized_at = now(),
         error = EXCLUDED.error,
         attempts = CASE
           WHEN EXCLUDED.error IS NULL THEN 0
           ELSE normalization_log.attempts + 1
         END,
         quarantined = CASE
           WHEN EXCLUDED.error IS NULL THEN false
           ELSE (normalization_log.attempts + 1) >= $5
         END
       RETURNING attempts, quarantined`,
      [row.id, row.tenant_id, row.parser, errorMessage, maxAttempts],
    );
    return rows[0] ?? { attempts: errorMessage === null ? 0 : 1, quarantined: false };
  });
}

export interface NormalizeWorkerOptions {
  /** Polling interval in milliseconds. Default: 15 000 (15 s). */
  intervalMs?: number;
  /** Maximum rows to process per poll cycle. Default: 20. */
  batchSize?: number;
  /** Actor id attributed to normalization audit events. */
  actor?: string;
  /** Failed rows quarantined after this many attempts. Default: 5. */
  maxAttempts?: number;
}

export type NormalizeWorker = ManagedWorker;

export function startNormalizeWorker(
  deps: { pool: Pool; audit: AuditEmitter },
  opts?: NormalizeWorkerOptions,
): NormalizeWorker {
  const intervalMs = opts?.intervalMs ?? 15_000;
  const batchSize = opts?.batchSize ?? 20;
  const actor = opts?.actor ?? "sys_normalize_worker";

  // Advisory lease: only one replica normalizes at a time (multi-replica safe).
  return startManagedInterval(
    leasedCycle({
      pool: deps.pool,
      lockKey: "brain_worker_normalize",
      cycle: () =>
        runNormalizeCycle(
          { pool: deps.pool, audit: deps.audit },
          { batchSize, actor, maxAttempts: opts?.maxAttempts },
        ),
      name: "normalize",
    }),
    intervalMs,
    {
      name: "normalize",
      runImmediately: true,
      onError: (err) => console.error("[normalizeWorker] cycle failed:", err),
    },
  );
}

/** One normalize cycle. Exported for tests; startNormalizeWorker schedules it. */
export async function runNormalizeCycle(
  deps: NormalizeCycleDeps,
  opts?: NormalizeWorkerOptions,
): Promise<void> {
  const batchSize = opts?.batchSize ?? 20;
  const actor = opts?.actor ?? "sys_normalize_worker";
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_NORMALIZATION_ATTEMPTS;
  const normalizeRow =
    deps.normalizeRow ??
    (async (row: PendingNormalizeRow, rowActor: string) => {
      if (deps.audit === undefined) {
        throw new Error("normalize audit emitter is required");
      }
      const ledgerDeps: LedgerDeps = { pool: deps.pool, audit: deps.audit };
      const ledgerService = new LedgerService(ledgerDeps);
      await ledgerService.normalizeFromRaw(
        { tenantId: row.tenant_id, actor: rowActor, requestId: `normalize_${row.id}` },
        row.id,
      );
    });

  let rows: PendingNormalizeRow[];
  try {
    // Cross-tenant poll requires BYPASSRLS or superuser in production. Failed
    // rows stay eligible until they are quarantined; successful and quarantined
    // rows are terminal.
    const result = await deps.pool.query<PendingNormalizeRow>(
      `SELECT rp.id, rp.tenant_id, rp.parser
         FROM raw_parsed rp
        WHERE rp.parser = ANY($2::text[])
          AND NOT EXISTS (
            SELECT 1 FROM normalization_log nl
             WHERE nl.raw_parsed_id = rp.id
               AND (nl.error IS NULL OR nl.quarantined)
          )
        ORDER BY rp.extracted_at ASC
        LIMIT $1`,
      [batchSize, registeredParsers()],
    );
    rows = result.rows;
  } catch (err) {
    console.error("[normalizeWorker] poll query failed:", err);
    return;
  }

  for (const row of rows) {
    let errorMessage: string | null = null;
    try {
      await normalizeRow(row, actor);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[normalizeWorker] normalizeFromRaw failed for ${row.id}:`, errorMessage);
    }

    try {
      const result = await recordNormalizationResult(deps.pool, row, errorMessage, { maxAttempts });
      if (errorMessage !== null && result.quarantined) {
        deps.metrics?.increment("brain.ledger.normalize.quarantined.count", {
          parser: row.parser,
          tenant_id: row.tenant_id,
        });
      }
    } catch (err) {
      console.error(`[normalizeWorker] failed to write normalization_log for ${row.id}:`, err);
    }
  }
}
