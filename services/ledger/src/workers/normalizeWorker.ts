/**
 * Plaid normalization worker.
 *
 * Polls raw_parsed for rows with parser = 'plaid_tx_v1' that have not yet
 * been promoted to Ledger entities, then calls LedgerService.normalizeFromRaw
 * for each one. Uses normalization_log (Ledger-owned) to track state so
 * repeated runs are idempotent.
 *
 * The polling query reads raw_parsed cross-service (the same controlled
 * exception documented in LedgerService.normalizeFromRaw). In production
 * the DB user must have BYPASSRLS or superuser privileges for the cross-
 * tenant poll query; the actual normalization runs per-tenant via
 * withTenantScope.
 */

import type { Pool } from "pg";
import type { AuditEmitter } from "@brain/api/shared";
import { LedgerService } from "../service/LedgerService.js";
import type { LedgerDeps } from "../deps.js";

export interface NormalizeWorkerOptions {
  /** Polling interval in milliseconds. Default: 15 000 (15 s). */
  intervalMs?: number;
  /** Maximum rows to process per poll cycle. Default: 20. */
  batchSize?: number;
  /** Actor id attributed to normalization audit events. */
  actor?: string;
}

export interface NormalizeWorker {
  stop(): void;
}

export function startNormalizeWorker(
  deps: { pool: Pool; audit: AuditEmitter },
  opts?: NormalizeWorkerOptions,
): NormalizeWorker {
  const intervalMs = opts?.intervalMs ?? 15_000;
  const batchSize = opts?.batchSize ?? 20;
  const actor = opts?.actor ?? "sys_normalize_worker";

  const ledgerDeps: LedgerDeps = { pool: deps.pool, audit: deps.audit };
  const ledgerService = new LedgerService(ledgerDeps);

  let active = true;

  async function poll(): Promise<void> {
    if (!active) return;

    let rows: Array<{ id: string; tenant_id: string }>;
    try {
      // Cross-tenant poll — requires BYPASSRLS or superuser in production.
      const result = await deps.pool.query<{ id: string; tenant_id: string }>(
        `SELECT rp.id, rp.tenant_id
           FROM raw_parsed rp
          WHERE rp.parser = 'plaid_tx_v1'
            AND NOT EXISTS (
              SELECT 1 FROM normalization_log nl
               WHERE nl.raw_parsed_id = rp.id
            )
          ORDER BY rp.extracted_at ASC
          LIMIT $1`,
        [batchSize],
      );
      rows = result.rows;
    } catch (err) {
      console.error("[normalizeWorker] poll query failed:", err);
      return;
    }

    for (const row of rows) {
      if (!active) break;
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
        await deps.pool.query(
          `INSERT INTO normalization_log (raw_parsed_id, tenant_id, parser, normalized_at, error)
           VALUES ($1, $2, 'plaid_tx_v1', now(), $3)
           ON CONFLICT (raw_parsed_id) DO NOTHING`,
          [row.id, row.tenant_id, errorMessage],
        );
      } catch (err) {
        console.error(`[normalizeWorker] failed to write normalization_log for ${row.id}:`, err);
      }
    }
  }

  const handle = setInterval(() => {
    void poll();
  }, intervalMs);

  void poll();

  return {
    stop() {
      active = false;
      clearInterval(handle);
    },
  };
}
