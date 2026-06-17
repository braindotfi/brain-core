/**
 * Ledger chart-of-accounts projection worker (Phase 5 PR-C, RFC 0005).
 *
 * Keeps ledger_gl_accounts current as canonical_gl_account grows: the steady-
 * state companion to rebuildAccountingProjectionFromCanonical (which does a
 * full per-tenant regenerate for the rebuild AC). Polls canonical GL accounts
 * that have no projection yet, or whose canonical row is newer than its
 * projection, and upserts them (overlay-preserving).
 *
 * The poll is cross-tenant (BYPASSRLS privileged pool, same controlled
 * exception the canonical/normalize/interpret workers use); each upsert runs
 * tenant-scoped. Reading canonical_* from the Ledger is the sanctioned
 * read-projection pattern (Wiki-reads-Ledger, one layer up); the Ledger never
 * writes canonical.
 */

import type { Pool } from "pg";
import { startManagedInterval, withTenantScope, type ManagedWorker } from "@brain/shared";
import { toLedgerGlAccountInput, upsertLedgerGlAccount } from "./gl-accounts.js";

export interface LedgerProjectionWorkerDeps {
  pool: Pool;
}

export interface LedgerProjectionWorkerOptions {
  /** Polling interval in milliseconds. Default: 15 000 (15 s). */
  intervalMs?: number;
  /** Maximum canonical rows per poll cycle. Default: 50. */
  batchSize?: number;
}

export type LedgerProjectionWorker = ManagedWorker;

interface CanonicalRow {
  id: string;
  tenant_id: string;
  source_system: string;
  source_natural_key: string;
  name: string;
  classification: string;
  account_number: string | null;
  currency: string | null;
  status: string | null;
  source_ids: string[];
  evidence_ids: string[];
}

/** One projection cycle. Exported for tests; startLedgerProjectionWorker schedules it. */
export async function runLedgerProjectionCycle(
  deps: LedgerProjectionWorkerDeps,
  opts?: LedgerProjectionWorkerOptions,
): Promise<void> {
  const batchSize = opts?.batchSize ?? 50;

  let rows: CanonicalRow[];
  try {
    // Cross-tenant poll: canonical accounts with no projection, or whose
    // canonical row is newer than the existing projection.
    const result = await deps.pool.query<CanonicalRow>(
      `SELECT cga.id, cga.tenant_id, cga.source_system, cga.source_natural_key, cga.name,
              cga.classification, cga.account_number, cga.currency, cga.status,
              cga.source_ids, cga.evidence_ids
         FROM canonical_gl_account cga
         LEFT JOIN ledger_gl_accounts lga
           ON lga.tenant_id = cga.tenant_id
          AND lga.source_system = cga.source_system
          AND lga.source_natural_key = cga.source_natural_key
        WHERE lga.id IS NULL OR lga.updated_at < cga.updated_at
        ORDER BY cga.updated_at ASC
        LIMIT $1`,
      [batchSize],
    );
    rows = result.rows;
  } catch (err) {
    console.error("[ledgerProjectionWorker] poll query failed:", err);
    return;
  }

  for (const row of rows) {
    try {
      await withTenantScope(deps.pool, row.tenant_id, async (c) => {
        await upsertLedgerGlAccount(c, row.tenant_id, toLedgerGlAccountInput(row));
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ledgerProjectionWorker] projection failed for ${row.id}:`, message);
    }
  }
}

export function startLedgerProjectionWorker(
  deps: LedgerProjectionWorkerDeps,
  opts?: LedgerProjectionWorkerOptions,
): LedgerProjectionWorker {
  const intervalMs = opts?.intervalMs ?? 15_000;
  return startManagedInterval(() => runLedgerProjectionCycle(deps, opts), intervalMs, {
    name: "ledger-projection",
    runImmediately: true,
    onError: (err) => console.error("[ledgerProjectionWorker] cycle failed:", err),
  });
}
