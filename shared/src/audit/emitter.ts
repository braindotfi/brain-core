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
 * Hash chain: we serialize emit within a single Postgres transaction per
 * tenant. The chain's invariant (`prev_event_hash` equals the previous
 * event's `event_hash` for that tenant) is enforced using a row lock on
 * the latest tenant event inside the transaction. That makes concurrent
 * emits for the same tenant serializable without a Redis-mediated lock.
 */

import type { Pool, PoolClient } from "pg";
import { newAuditEventId } from "../ids.js";
import { hashEvent } from "./hash.js";
import type { AuditEvent, AuditEventInput } from "./types.js";

export interface AuditEmitter {
  emit(event: AuditEventInput): Promise<AuditEvent>;
}

/** For tests and for bootstrap paths where a real DB isn't available. */
export class InMemoryAuditEmitter implements AuditEmitter {
  public readonly events: AuditEvent[] = [];

  public async emit(event: AuditEventInput): Promise<AuditEvent> {
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

      // Lock the most recent event for this tenant (if any) to serialize.
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
           event_hash, prev_event_hash, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
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
