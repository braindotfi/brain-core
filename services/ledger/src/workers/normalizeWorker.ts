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
} from "@brain/shared";
import type { ManagedWorker } from "@brain/shared";
import { LedgerService } from "../service/LedgerService.js";
import { registeredParsers } from "../extractors/registry.js";
import type { LedgerDeps } from "../deps.js";

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
): Promise<void> {
  await withTenantScope(pool, row.tenant_id, async (c) => {
    await c.query(
      `INSERT INTO normalization_log (raw_parsed_id, tenant_id, parser, normalized_at, error)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (raw_parsed_id) DO NOTHING`,
      [row.id, row.tenant_id, row.parser, errorMessage],
    );
  });
}

export interface NormalizeWorkerOptions {
  /** Polling interval in milliseconds. Default: 15 000 (15 s). */
  intervalMs?: number;
  /** Maximum rows to process per poll cycle. Default: 20. */
  batchSize?: number;
  /** Actor id attributed to normalization audit events. */
  actor?: string;
}

export type NormalizeWorker = ManagedWorker;

export function startNormalizeWorker(
  deps: { pool: Pool; audit: AuditEmitter },
  opts?: NormalizeWorkerOptions,
): NormalizeWorker {
  const intervalMs = opts?.intervalMs ?? 15_000;
  const batchSize = opts?.batchSize ?? 20;
  const actor = opts?.actor ?? "sys_normalize_worker";

  const ledgerDeps: LedgerDeps = { pool: deps.pool, audit: deps.audit };
  const ledgerService = new LedgerService(ledgerDeps);

  async function poll(): Promise<void> {
    let rows: Array<{ id: string; tenant_id: string; parser: string }>;
    try {
      // Cross-tenant poll — requires BYPASSRLS or superuser in production.
      const result = await deps.pool.query<{ id: string; tenant_id: string; parser: string }>(
        `SELECT rp.id, rp.tenant_id, rp.parser
           FROM raw_parsed rp
          WHERE rp.parser = ANY($2::text[])
            AND NOT EXISTS (
              SELECT 1 FROM normalization_log nl
               WHERE nl.raw_parsed_id = rp.id
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
        await ledgerService.normalizeFromRaw(
          { tenantId: row.tenant_id, actor, requestId: `normalize_${row.id}` },
          row.id,
        );
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[normalizeWorker] normalizeFromRaw failed for ${row.id}:`, errorMessage);
      }

      try {
        await recordNormalizationResult(deps.pool, row, errorMessage);
      } catch (err) {
        console.error(`[normalizeWorker] failed to write normalization_log for ${row.id}:`, err);
      }
    }
  }

  // Advisory lease: only one replica normalizes at a time (multi-replica safe).
  return startManagedInterval(
    leasedCycle({
      pool: deps.pool,
      lockKey: "brain_worker_normalize",
      cycle: poll,
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
