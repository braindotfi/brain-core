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
import { AUDIT_HASH_SCHEMA_VERSION, hashEvent } from "@brain/shared";
import type { AuditEventInput, MetricsEmitter } from "@brain/shared";

export interface AuditConsistencyDeps {
  /**
   * MUST be the cross-tenant privileged pool (the BYPASSRLS `brain_privileged`
   * role), NOT the request-path pool. The fork/gap queries scan every tenant's
   * chain and deliberately set no `app.tenant_id`; under the request role's
   * `FORCE ROW LEVEL SECURITY` that predicate (`tenant_id =
   * current_setting('app.tenant_id', true)`) matches ZERO rows, so the verifier
   * would report a permanent false-clean. Passing the privileged pool is what
   * lets this detective control actually see the data it is meant to verify.
   */
  privilegedPool: Pool;
  metrics?: MetricsEmitter;
  /**
   * Max rows the content-hash recompute scans per cycle (most-recent first,
   * current schema version only). Bounds the cost on large tables. Default 1000.
   */
  hashScanLimit?: number;
}

export interface AuditConsistencyResult {
  /** Distinct (tenant, predecessor) groups with more than one successor — a fork. */
  forks: number;
  /** Events whose prev_event_hash references no event_hash for the same tenant. */
  gaps: number;
  /**
   * Non-empty tenants whose count of genesis (null-predecessor) events is not
   * exactly one. Two genesis events escape both the fork check (which excludes
   * null predecessors) and the gap check (each genesis is self-consistent), so a
   * forked or duplicated chain head is otherwise invisible.
   */
  invalidGenesis: number;
  /**
   * Current-version events whose recomputed canonical hash does NOT equal the
   * stored event_hash — a content mutation (privileged tamper or migration
   * defect) that the structural checks cannot see, because the chain stays
   * structurally connected. Bounded scan (see `hashScanLimit`).
   */
  hashMismatches: number;
}

export async function checkAuditConsistency(
  deps: AuditConsistencyDeps,
): Promise<AuditConsistencyResult> {
  // Fork: >1 event for one tenant chained off the same predecessor.
  const forkRes = await deps.privilegedPool.query<{ n: string }>(
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
  const gapRes = await deps.privilegedPool.query<{ n: string }>(
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

  // Genesis cardinality: a healthy non-empty tenant has EXACTLY ONE event with a
  // null predecessor. A tenant with no events contributes no row here and is
  // correctly not flagged; one with two genesis events (legacy or corrupted) or
  // zero (a missing chain head) is.
  const genesisRes = await deps.privilegedPool.query<{ n: string }>(
    `SELECT count(*)::bigint AS n FROM (
       SELECT tenant_id
         FROM audit_events
        GROUP BY tenant_id
       HAVING count(*) FILTER (WHERE prev_event_hash IS NULL) <> 1
     ) invalid_genesis`,
  );
  const invalidGenesis = Number(genesisRes.rows[0]?.n ?? 0);

  // Content integrity: recompute the canonical hash from persisted logical fields
  // and compare to the stored event_hash. Catches a privileged mutation or
  // migration defect that changed actor/action/inputs/outputs/policy/state
  // WITHOUT rehashing — the structural fork/gap/genesis checks see such a chain
  // as healthy because it stays structurally connected. Bounded to the most
  // recent `hashScanLimit` rows AT THE CURRENT schema version, so a superseded
  // serialization is never flagged. (Codex c96283d P1 #2.)
  const hashScanLimit = deps.hashScanLimit ?? 1000;
  const contentRes = await deps.privilegedPool.query<{
    id: string;
    tenant_id: string;
    layer: AuditEventInput["layer"];
    actor: string;
    action: string;
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
    policy_version: number | null;
    policy_decision_id: string | null;
    before_state: Record<string, unknown> | null;
    after_state: Record<string, unknown> | null;
    prev_event_hash: Buffer | null;
    created_at: Date;
    event_hash: Buffer;
  }>(
    `SELECT id, tenant_id, layer, actor, action, inputs, outputs,
            policy_version, policy_decision_id, before_state, after_state,
            prev_event_hash, created_at, event_hash
       FROM audit_events
      WHERE hash_schema_version = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [AUDIT_HASH_SCHEMA_VERSION, hashScanLimit],
  );
  let hashMismatches = 0;
  for (const r of contentRes.rows) {
    const recomputed = hashEvent({
      event: {
        tenantId: r.tenant_id,
        layer: r.layer,
        actor: r.actor,
        action: r.action,
        inputs: r.inputs,
        outputs: r.outputs,
        ...(r.policy_version !== null ? { policyVersion: r.policy_version } : {}),
        ...(r.policy_decision_id !== null ? { policyDecisionId: r.policy_decision_id } : {}),
        ...(r.before_state !== null ? { beforeState: r.before_state } : {}),
        ...(r.after_state !== null ? { afterState: r.after_state } : {}),
      },
      id: r.id,
      createdAt: r.created_at.toISOString(),
      prevEventHash: r.prev_event_hash === null ? null : r.prev_event_hash.toString("hex"),
    });
    if (recomputed !== r.event_hash.toString("hex")) hashMismatches += 1;
  }

  deps.metrics?.gauge("brain.audit.consistency.fork.count", forks);
  deps.metrics?.gauge("brain.audit.consistency.gap.count", gaps);
  deps.metrics?.gauge("brain.audit.consistency.invalid_genesis.count", invalidGenesis);
  deps.metrics?.gauge("brain.audit.consistency.hash_mismatch.count", hashMismatches);
  if (forks > 0 || gaps > 0 || invalidGenesis > 0 || hashMismatches > 0) {
    console.error("[audit-consistency] per-tenant hash-chain inconsistency detected", {
      forks,
      gaps,
      invalidGenesis,
      hashMismatches,
    });
  }
  return { forks, gaps, invalidGenesis, hashMismatches };
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
