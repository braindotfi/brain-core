/**
 * Brain audit emitter.
 *
 * §1 principle 4: "Audit everything that matters. Every API call, policy
 * evaluation, agent action, and state transition produces an audit event.
 * The audit log is append-only and Merkle-chained. If it is not in the
 * log, it did not happen."
 *
 * Every service calls this emitter to record that-which-happened.
 *
 * Stage-1 implementation: a Postgres-backed emitter that writes directly to
 * `audit_events`. The table is owned by the Audit service (§2), but its
 * migration is shipped in Stage 1 so non-audit services can emit from
 * day one. When Stage 7 lands the Audit service's API, the emitter will be
 * rewired to call that API (or enqueue to BullMQ) instead of writing the
 * row directly. The interface stays the same; implementations swap.
 *
 * Hash chain: we serialize emit per tenant with a transaction-scoped advisory
 * lock keyed by the tenant id (`pg_advisory_xact_lock`), held until COMMIT/
 * ROLLBACK. A row lock on the latest event is NOT sufficient: a tenant with no
 * events yet has no row to lock (genesis race), and `ORDER BY ... LIMIT 1 FOR
 * UPDATE` only locks the row found at query start, so a concurrent emit that
 * already passed that point appends off the same predecessor and FORKS the
 * chain. The advisory lock makes emits for one tenant strictly serial (each
 * sees the true latest event) while different tenants stay concurrent. (Codex
 * 2026-06-07 P1: concurrent audit writes must not fork the per-tenant chain.)
 */

import type { Pool, PoolClient } from "pg";
import { newAuditEventId } from "../ids.js";
import { hashEvent } from "./hash.js";
import type { AuditEvent, AuditEventInput } from "./types.js";

// Fixed advisory-lock namespace (int4) for the per-tenant audit chain. Paired
// with hashtext(tenant_id) so the two-key form locks one namespace per tenant.
// Value is arbitrary but stable: 0x41554454 = "AUDT".
const AUDIT_CHAIN_LOCK_NAMESPACE = 0x41554454;

export interface AuditEmitter {
  emit(event: AuditEventInput): Promise<AuditEvent>;
}

/** For tests and for bootstrap paths where a real DB isn't available. */
export class InMemoryAuditEmitter implements AuditEmitter {
  public readonly events: AuditEvent[] = [];

  public async emit(event: AuditEventInput): Promise<AuditEvent> {
    // Idempotent delivery parity with the Postgres emitter: same tenant + key
    // returns the existing event rather than a duplicate.
    if (event.idempotencyKey !== undefined) {
      const existing = this.events.find(
        (e) => e.tenantId === event.tenantId && e.idempotencyKey === event.idempotencyKey,
      );
      if (existing !== undefined) return existing;
    }
    const id = newAuditEventId();
    const createdAt = new Date().toISOString();
    const prev = this.latestForTenant(event.tenantId);
    const eventHash = hashEvent({
      event,
      id,
      createdAt,
      prevEventHash: prev?.eventHash ?? null,
    });
    const stored: AuditEvent = {
      ...event,
      id,
      createdAt,
      eventHash,
      prevEventHash: prev?.eventHash ?? null,
    };
    this.events.push(stored);
    return stored;
  }

  public latestForTenant(tenantId: string): AuditEvent | undefined {
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const e = this.events[i]!;
      if (e.tenantId === tenantId) return e;
    }
    return undefined;
  }
}

/**
 * Postgres-backed emitter. Uses a dedicated connection checkout per emit so
 * it does not participate in the caller's tenant-scoped transaction — this
 * emitter runs as a privileged BYPASSRLS role (configured in stage-8).
 *
 * §5.3: the emitter is NOT what enforces anchor idempotency; that lives in
 * the audit anchor publisher (Stage 7). This emitter guarantees that a
 * successful emit has been durably persisted and chained.
 */
export class PostgresAuditEmitter implements AuditEmitter {
  public constructor(private readonly pool: Pool) {}

  public async emit(event: AuditEventInput): Promise<AuditEvent> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Set tenant scope for RLS — audit_events has per-tenant isolation policies.
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [event.tenantId]);

      // Serialize all emits for THIS tenant so the per-tenant hash chain cannot
      // fork under concurrency. Transaction-scoped (auto-released at COMMIT/
      // ROLLBACK); different tenants hash to different keys and stay concurrent.
      await client.query(
        `SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_NAMESPACE}, hashtext($1))`,
        [event.tenantId],
      );

      // Idempotent delivery: if this logical event was already written (same
      // tenant + external idempotency key), return it instead of inserting a
      // duplicate. Makes an at-least-once publisher effectively exactly-once.
      // Race-free here because the advisory lock serialises this tenant's emits.
      if (event.idempotencyKey !== undefined) {
        const existing = await client.query<{
          id: string;
          event_hash: Buffer;
          prev_event_hash: Buffer | null;
          created_at: Date;
        }>(
          `SELECT id, event_hash, prev_event_hash, created_at
             FROM audit_events
            WHERE tenant_id = $1 AND idempotency_key = $2
            LIMIT 1`,
          [event.tenantId, event.idempotencyKey],
        );
        const hit = existing.rows[0];
        if (hit !== undefined) {
          await client.query("COMMIT");
          return {
            ...event,
            id: hit.id,
            createdAt: hit.created_at.toISOString(),
            eventHash: hit.event_hash.toString("hex"),
            prevEventHash:
              hit.prev_event_hash === null ? null : hit.prev_event_hash.toString("hex"),
          };
        }
      }

      // Read the most recent event for this tenant (now race-free under the lock).
      const prev = await client.query<{ event_hash: string }>(
        `SELECT event_hash
           FROM audit_events
          WHERE tenant_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 1
          FOR UPDATE`,
        [event.tenantId],
      );
      const prevHash = prev.rows[0]?.event_hash ?? null;

      const id = newAuditEventId();
      const createdAt = new Date().toISOString();
      const eventHash = hashEvent({
        event,
        id,
        createdAt,
        prevEventHash: prevHash,
      });

      await client.query(
        `INSERT INTO audit_events (
           id, tenant_id, layer, actor, action, inputs, outputs,
           policy_version, policy_decision_id, before_state, after_state,
           event_hash, prev_event_hash, created_at, idempotency_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          id,
          event.tenantId,
          event.layer,
          event.actor,
          event.action,
          JSON.stringify(event.inputs),
          JSON.stringify(event.outputs),
          event.policyVersion ?? null,
          event.policyDecisionId ?? null,
          event.beforeState === undefined ? null : JSON.stringify(event.beforeState),
          event.afterState === undefined ? null : JSON.stringify(event.afterState),
          Buffer.from(eventHash, "hex"),
          prevHash === null ? null : Buffer.from(prevHash, "hex"),
          createdAt,
          event.idempotencyKey ?? null,
        ],
      );

      await client.query("COMMIT");
      return {
        ...event,
        id,
        createdAt,
        eventHash,
        prevEventHash: prevHash,
      };
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* swallow — original error wins */
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
