/**
 * Single-active leader election for idempotent background workers.
 *
 * Some pollers (canonical/ledger projections, normalize, webhook dispatch) are
 * idempotent but not item-claim-protected, so running >1 replica double-polls
 * and contends. `leasedCycle` wraps a worker's cycle in a per-worker Postgres
 * session advisory lock: each tick tries the lock; the holder runs the cycle,
 * everyone else skips that tick. One replica is active at a time, and if it dies
 * mid-cycle its connection drops and the lock auto-releases, so a standby takes
 * over on the next tick (bounded handover = one interval). This makes running
 * multiple replicas safe (failover) without per-item claim infrastructure.
 *
 * The lock rides a dedicated lease client for the whole cycle; the cycle's own
 * DB work uses separate pooled connections (withTenantScope) — the lease client
 * is only a coordination token. Keep keys distinct per worker.
 *
 * Mirrors the advisory-lock pattern already used by the migration runner and
 * ReconciliationService. `startManagedInterval` stays pg-free; compose them:
 *   startManagedInterval(leasedCycle({ pool, lockKey, cycle }), intervalMs, opts)
 */

import type { Pool } from "pg";
import type { MetricsEmitter } from "../metrics.js";

export interface LeasedCycleOptions {
  /** Pool to draw the lease client from (the worker's own pool). */
  pool: Pool;
  /** Stable per-worker key, e.g. "brain_worker_canonical_projection". */
  lockKey: string;
  /** The worker cycle to run only when this process holds the lease. */
  cycle: () => Promise<void>;
  /** Label for the skip metric; defaults to lockKey. */
  name?: string;
  /** Optional: emits brain.worker.lease.skipped when another replica is active.
   *  Accepts undefined so callers can forward an optional deps.metrics directly
   *  (exactOptionalPropertyTypes). */
  metrics?: MetricsEmitter | undefined;
}

/**
 * Wrap a worker cycle so it runs only while this process holds the worker's
 * advisory lock. When another replica holds it, the cycle is skipped (no-op for
 * this tick). Never throws on contention; the cycle's own errors propagate to
 * the caller (startManagedInterval's onError).
 */
export function leasedCycle(opts: LeasedCycleOptions): () => Promise<void> {
  const { pool, lockKey, cycle, metrics } = opts;
  const worker = opts.name ?? lockKey;
  return async (): Promise<void> => {
    const client = await pool.connect();
    try {
      const res = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
        [lockKey],
      );
      if (res.rows[0]?.locked !== true) {
        // Another replica is the active worker this tick.
        metrics?.increment("brain.worker.lease.skipped", { worker });
        return;
      }
      try {
        await cycle();
      } finally {
        // Release within the same session so a standby can take over next tick.
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
      }
    } finally {
      client.release();
    }
  };
}
