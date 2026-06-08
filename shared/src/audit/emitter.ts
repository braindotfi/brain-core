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
import { brainError } from "../errors.js";
import { AUDIT_HASH_SCHEMA_VERSION, hashEvent, logicalPayloadFingerprint } from "./hash.js";
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
      if (existing !== undefined) {
        // Same conflict check as the Postgres emitter: recompute the hash with
        // the caller's payload pinned to the stored chain fields. A mismatch
        // means the key was reused for different content (doc A P1.2).
        const recomputed = hashEvent({
          event,
          id: existing.id,
          createdAt: existing.createdAt,
          prevEventHash: existing.prevEventHash,
        });
        if (recomputed !== existing.eventHash) {
          throw brainError(
            "audit_idempotency_conflict",
            "idempotency key reused for a different audit event payload",
            { details: { tenantId: event.tenantId, idempotencyKey: event.idempotencyKey } },
          );
        }
        return existing;
      }
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
          hash_schema_version: number;
          layer: AuditEventInput["layer"];
          actor: string;
          action: string;
          inputs: Record<string, unknown>;
          outputs: Record<string, unknown>;
          policy_version: number | null;
          policy_decision_id: string | null;
          before_state: Record<string, unknown> | null;
          after_state: Record<string, unknown> | null;
        }>(
          `SELECT id, event_hash, prev_event_hash, created_at, hash_schema_version,
                  layer, actor, action, inputs, outputs,
                  policy_version, policy_decision_id, before_state, after_state
             FROM audit_events
            WHERE tenant_id = $1 AND idempotency_key = $2
            LIMIT 1`,
          [event.tenantId, event.idempotencyKey],
        );
        const hit = existing.rows[0];
        if (hit !== undefined) {
          const storedHash = hit.event_hash.toString("hex");
          const prevEventHash =
            hit.prev_event_hash === null ? null : hit.prev_event_hash.toString("hex");

          // Conflict detection is VERSION-AWARE (Codex fca9ac8 P1 #1):
          //   - current version: recompute the hash with the caller's payload
          //     pinned to the stored chain fields and compare (exact serializer);
          //   - version 0 (pre-versioning, e.g. the pre-BYTEA-fix Buffer hash):
          //     the stored hash used a SUPERSEDED canonicalization, so a recompute
          //     would falsely conflict — compare the persisted LOGICAL fields
          //     directly instead;
          //   - any other version: a row this build cannot verify — fail closed.
          let conflict: boolean;
          if (hit.hash_schema_version === AUDIT_HASH_SCHEMA_VERSION) {
            conflict =
              hashEvent({
                event,
                id: hit.id,
                createdAt: hit.created_at.toISOString(),
                prevEventHash,
              }) !== storedHash;
          } else if (hit.hash_schema_version === 0) {
            const stored: AuditEventInput = {
              tenantId: event.tenantId,
              layer: hit.layer,
              actor: hit.actor,
              action: hit.action,
              inputs: hit.inputs,
              outputs: hit.outputs,
              ...(hit.policy_version !== null ? { policyVersion: hit.policy_version } : {}),
              ...(hit.policy_decision_id !== null
                ? { policyDecisionId: hit.policy_decision_id }
                : {}),
              ...(hit.before_state !== null ? { beforeState: hit.before_state } : {}),
              ...(hit.after_state !== null ? { afterState: hit.after_state } : {}),
            };
            conflict = logicalPayloadFingerprint(event) !== logicalPayloadFingerprint(stored);
          } else {
            throw brainError(
              "audit_hash_version_unsupported",
              `audit row hash_schema_version ${hit.hash_schema_version} is not verifiable by this build`,
              { details: { tenantId: event.tenantId, idempotencyKey: event.idempotencyKey } },
            );
          }

          if (conflict) {
            // The catch below rolls back this read-only transaction.
            throw brainError(
              "audit_idempotency_conflict",
              "idempotency key reused for a different audit event payload",
              { details: { tenantId: event.tenantId, idempotencyKey: event.idempotencyKey } },
            );
          }
          await client.query("COMMIT");
          // Content equality is proven (by hash or by logical-field comparison),
          // so this is equivalent to reconstructing the row from the DB.
          return {
            ...event,
            id: hit.id,
            createdAt: hit.created_at.toISOString(),
            eventHash: storedHash,
            prevEventHash,
          };
        }
      }

      // Read the most recent event for this tenant (race-free under the
      // per-tenant advisory lock taken above — no row lock needed, and a plain
      // SELECT here is REQUIRED: the append-only grant model revokes UPDATE on
      // audit_events from the runtime roles, so a `FOR UPDATE` row lock would
      // raise `permission denied for table audit_events` (42501). The advisory
      // lock already serialises this tenant's emits, so the row lock added
      // nothing anyway.
      // event_hash is a BYTEA column, so node-pg hands it back as a Buffer.
      // Normalize to the canonical hex string here: hashEvent's contract is a hex
      // predecessor, and leaking the raw Buffer would (a) canonicalize a
      // {"0":..} object instead of the hex digest and (b) make a non-genesis
      // idempotent replay falsely conflict (Codex c96283d P1).
      const prev = await client.query<{ event_hash: Buffer }>(
        `SELECT event_hash
           FROM audit_events
          WHERE tenant_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [event.tenantId],
      );
      const prevHash = prev.rows[0]?.event_hash.toString("hex") ?? null;

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
           event_hash, prev_event_hash, created_at, idempotency_key,
           hash_schema_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
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
          // Tag the row with the canonicalization that produced event_hash so the
          // consistency verifier only recomputes current-version rows.
          AUDIT_HASH_SCHEMA_VERSION,
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
