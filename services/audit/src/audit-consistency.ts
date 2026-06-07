/**
 * Runtime audit-consistency verifier (2026-06-07 review doc #2 §6.4).
 *
 * A background detective control over the per-tenant hash chain in
 * `audit_events`. The emitter's per-tenant advisory lock PREVENTS new chain
 * forks; this verifier DETECTS any pre-fix or regressed inconsistency so an
 * integrity break is observable (metrics + a critical log) rather than silent.
 *
 * Two checks, both within the audit service's own table (no cross-service read):
 *   - fork: two committed events for one tenant share a predecessor hash;
 *   - gap:  an event's prev_event_hash matches no event_hash for that tenant.
 *
 * A non-zero count is a P0-grade signal: the Merkle chain the on-chain anchor
 * commits to is no longer a single linear history for that tenant.
 */

import type { Pool } from "pg";
import type { MetricsEmitter } from "@brain/shared";

export interface AuditConsistencyDeps {
  pool: Pool;
  metrics?: MetricsEmitter;
}

export interface AuditConsistencyResult {
  /** Distinct (tenant, predecessor) groups with more than one successor — a fork. */
  forks: number;
  /** Events whose prev_event_hash references no event_hash for the same tenant. */
  gaps: number;
}

export async function checkAuditConsistency(
  deps: AuditConsistencyDeps,
): Promise<AuditConsistencyResult> {
  // Fork: >1 event for one tenant chained off the same predecessor.
  const forkRes = await deps.pool.query<{ n: string }>(
    `SELECT count(*)::bigint AS n FROM (
       SELECT tenant_id, prev_event_hash
         FROM audit_events
        WHERE prev_event_hash IS NOT NULL
        GROUP BY tenant_id, prev_event_hash
       HAVING count(*) > 1
     ) forks`,
  );
  const forks = Number(forkRes.rows[0]?.n ?? 0);

  // Gap: an event whose predecessor hash is not the event_hash of any event for
  // the same tenant — a broken chain link (a missing or mismatched predecessor).
  const gapRes = await deps.pool.query<{ n: string }>(
    `SELECT count(*)::bigint AS n
       FROM audit_events e
      WHERE e.prev_event_hash IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM audit_events p
           WHERE p.tenant_id = e.tenant_id
             AND p.event_hash = e.prev_event_hash
        )`,
  );
  const gaps = Number(gapRes.rows[0]?.n ?? 0);

  deps.metrics?.gauge("brain.audit.consistency.fork.count", forks);
  deps.metrics?.gauge("brain.audit.consistency.gap.count", gaps);
  if (forks > 0 || gaps > 0) {
    console.error("[audit-consistency] per-tenant hash-chain inconsistency detected", {
      forks,
      gaps,
    });
  }
  return { forks, gaps };
}

export interface AuditConsistencyVerifier {
  stop(): void;
}

/** Run checkAuditConsistency on a fixed cadence (default every 10 minutes). */
export function startAuditConsistencyVerifier(
  deps: AuditConsistencyDeps,
  opts: { intervalMs?: number } = {},
): AuditConsistencyVerifier {
  const intervalMs = opts.intervalMs ?? 10 * 60 * 1000;
  let active = true;

  async function cycle(): Promise<void> {
    if (!active) return;
    try {
      await checkAuditConsistency(deps);
    } catch (err) {
      console.error("[audit-consistency] cycle failed:", err);
    }
  }

  const handle = setInterval(() => void cycle(), intervalMs);
  void cycle();

  return {
    stop() {
      active = false;
      clearInterval(handle);
    },
  };
}
