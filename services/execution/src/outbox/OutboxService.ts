/**
 * OutboxService — durable execution outbox (H-04).
 *
 * The transactional-outbox half of the §6 money-mover. `PaymentIntentService.
 * execute` enqueues a `pending` row here *inside the same transaction* that
 * moves the intent approved → dispatching (atomic: you cannot get one without
 * the other). A poll-based worker then claims `pending`/`reconciling` rows with
 * `FOR UPDATE SKIP LOCKED`, dispatches the rail, and settles the intent. A crash
 * between rail dispatch and the final write leaves the row claimable, so the
 * action settles exactly once on recovery rather than being silently lost.
 *
 * Connection model (Standards §1.2):
 *  - `enqueue` takes the caller's tenant-scoped client so the INSERT is atomic
 *    with the approved → dispatching transition. RLS scopes it to the tenant.
 *  - `claimNext` is inherently cross-tenant (one global worker drains every
 *    tenant's queue), so the worker runs it on a `brain_privileged` (BYPASSRLS)
 *    connection — the same sanctioned cross-tenant reader role used by the audit
 *    emitter and normalize worker. The per-row settle then re-enters a
 *    `withTenantScope(pool, row.tenant_id, …)` block.
 *
 * Methods take an explicit query client (rather than owning a Pool) to mirror
 * the repository.ts surface and stay unit-testable with a fake client. The real
 * `FOR UPDATE SKIP LOCKED` claim semantics + RLS require Postgres and are
 * covered by an integration test (blocked in the sandbox; see worker.test.ts).
 */

import { createHash } from "node:crypto";
import { newExecutionOutboxId, type TenantScopedClient } from "@brain/shared";

/** Minimal query surface the service needs (a tenant-scoped or privileged client). */
type OutboxClient = Pick<TenantScopedClient, "query">;

export type OutboxStatus =
  | "pending"
  | "dispatching"
  | "dispatched"
  | "settled"
  | "failed"
  | "reconciling";

export interface OutboxRow {
  id: string;
  tenant_id: string;
  payment_intent_id: string;
  execution_id: string | null;
  rail: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  payload_hash: Buffer;
  status: OutboxStatus;
  attempt_count: number;
  last_error: string | null;
  rail_receipt: Record<string, unknown> | null;
  audit_before_id: string;
  audit_after_id: string | null;
  reservation_id: string | null;
  locked_at: Date | null;
  locked_by: string | null;
  created_at: Date;
  dispatched_at: Date | null;
  completed_at: Date | null;
}

export interface EnqueueInput {
  paymentIntentId: string;
  rail: string;
  /** `pi:<id>:<policy_decision_id>` — same key the rail dispatch is keyed by. */
  idempotencyKey: string;
  /** Canonical rail dispatch payload; hashed for tamper-evidence. */
  payload: Record<string, unknown>;
  /** Gate audit-before event id; links the audit pair across the async boundary. */
  auditBeforeId: string;
  reservationId?: string;
}

export interface EnqueueResult {
  id: string;
  /** false when an existing row was returned (idempotent replay), true on insert. */
  created: boolean;
}

/** After-the-fact stuck threshold (spec: 3 attempts → reconciling). */
export const MAX_DISPATCH_ATTEMPTS = 3;

/** Stable JSON (recursively key-sorted) for a deterministic payload hash. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function payloadHash(payload: Record<string, unknown>): Buffer {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest();
}

export class OutboxService {
  /**
   * Insert a `pending` row, idempotent on (tenant_id, idempotency_key). On a
   * duplicate the existing row id is returned (created:false) so a retried
   * execute never enqueues the same dispatch twice. MUST run inside the same
   * transaction (tenant-scoped client) as the approved → dispatching transition.
   */
  public async enqueue(
    client: OutboxClient,
    tenantId: string,
    input: EnqueueInput,
  ): Promise<EnqueueResult> {
    const id = newExecutionOutboxId();
    const hash = payloadHash(input.payload);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO execution_outbox (
         id, tenant_id, payment_intent_id, rail, idempotency_key,
         payload, payload_hash, status, audit_before_id, reservation_id
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        id,
        tenantId,
        input.paymentIntentId,
        input.rail,
        input.idempotencyKey,
        JSON.stringify(input.payload),
        hash,
        input.auditBeforeId,
        input.reservationId ?? null,
      ],
    );
    const inserted = rows[0];
    if (inserted !== undefined) {
      return { id: inserted.id, created: true };
    }
    // Conflict: a row for this (tenant, idempotency_key) already exists.
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM execution_outbox WHERE idempotency_key = $1 LIMIT 1`,
      [input.idempotencyKey],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      throw new Error("execution_outbox enqueue: conflict but no existing row found");
    }
    return { id: row.id, created: false };
  }

  /**
   * Atomically claim up to `limit` outstanding rows: flip `pending`/`reconciling`
   * → `dispatching`, stamp the lock columns, and return them. `FOR UPDATE SKIP
   * LOCKED` lets concurrent workers claim disjoint row sets without blocking;
   * the status flip removes claimed rows from the partial claim index so no
   * other poll re-picks them. Run on a privileged (cross-tenant) connection.
   */
  public async claimNext(client: OutboxClient, workerId: string, limit = 10): Promise<OutboxRow[]> {
    const { rows } = await client.query<OutboxRow>(
      `UPDATE execution_outbox
          SET status = 'dispatching', locked_at = now(), locked_by = $1
        WHERE id IN (
          SELECT id FROM execution_outbox
            WHERE status IN ('pending', 'reconciling')
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT $2
        )
        RETURNING *`,
      [workerId, limit],
    );
    return rows;
  }

  /** Rail returned a receipt; persist it durably before settling the intent. */
  public async markDispatched(
    client: OutboxClient,
    id: string,
    args: { railReceipt: Record<string, unknown>; auditAfterId: string; executionId: string },
  ): Promise<void> {
    await client.query(
      `UPDATE execution_outbox
          SET status = 'dispatched', rail_receipt = $2, audit_after_id = $3,
              execution_id = $4, dispatched_at = now()
        WHERE id = $1`,
      [id, JSON.stringify(args.railReceipt), args.auditAfterId, args.executionId],
    );
  }

  /** The intent settled (dispatching → executed); the queue row is done. */
  public async markSettled(client: OutboxClient, id: string): Promise<void> {
    await client.query(
      `UPDATE execution_outbox SET status = 'settled', completed_at = now() WHERE id = $1`,
      [id],
    );
  }

  /**
   * Record a dispatch failure: bump attempt_count, store the error, and either
   * return the row to `pending` (more attempts remain) or `reconciling` (budget
   * exhausted — ops must investigate; money may have moved). Returns the new
   * attempt_count so the worker can decide whether to raise the stuck signal.
   */
  public async markFailed(client: OutboxClient, id: string, error: string): Promise<number> {
    const { rows } = await client.query<{ attempt_count: number }>(
      `UPDATE execution_outbox
          SET attempt_count = attempt_count + 1,
              last_error = $2,
              status = CASE
                WHEN attempt_count + 1 >= $3 THEN 'reconciling'
                ELSE 'pending'
              END,
              locked_at = NULL, locked_by = NULL
        WHERE id = $1
        RETURNING attempt_count`,
      [id, error, MAX_DISPATCH_ATTEMPTS],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`execution_outbox markFailed: no row ${id}`);
    return row.attempt_count;
  }

  /**
   * Crash recovery. A row claimed into `dispatching` whose worker died never
   * reaches a terminal state and is NOT in the claim index, so it would be
   * stranded. This returns `dispatching` rows whose lock is older than
   * `staleSeconds` back to `pending` so the next claim re-picks them. Combined
   * with the rail's idempotency key and the atomic conditional settle in
   * PaymentIntentService.completeExecution (insert-execution + dispatching →
   * executed in one tx; the transition no-ops and rolls the whole tx back if
   * already settled), re-dispatch is at-least-once but the *effect* is
   * exactly-once. Run on a privileged (cross-tenant) connection.
   */
  public async reclaimStale(client: OutboxClient, staleSeconds: number): Promise<OutboxRow[]> {
    // Both in-flight states are recoverable: `dispatching` (died before the
    // receipt was persisted) and `dispatched` (died after persist, before the
    // intent settled). Re-processing is safe — the rail call is idempotency-keyed
    // and completeExecution no-ops once the intent is already `executed`.
    const { rows } = await client.query<OutboxRow>(
      `UPDATE execution_outbox
          SET status = 'pending', locked_at = NULL, locked_by = NULL
        WHERE status IN ('dispatching', 'dispatched')
          AND locked_at IS NOT NULL
          AND locked_at < now() - ($1 * interval '1 second')
        RETURNING *`,
      [staleSeconds],
    );
    return rows;
  }

  /** Force a row into `reconciling` (e.g. a post-dispatch ambiguity). */
  public async markReconciling(client: OutboxClient, id: string, error: string): Promise<void> {
    await client.query(
      `UPDATE execution_outbox
          SET status = 'reconciling', last_error = $2, locked_at = NULL, locked_by = NULL
        WHERE id = $1`,
      [id, error],
    );
  }
}
