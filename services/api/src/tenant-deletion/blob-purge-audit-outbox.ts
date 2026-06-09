/**
 * Transactional audit outbox for the tenant blob purge worker (RFC 0003 / GDPR
 * Art. 17; review 2026-06-07 P2 #1).
 *
 * Every purge-job lifecycle transition writes its audit INTENT here in the SAME
 * transaction as the status change, so a state change and its audit evidence
 * commit atomically — neither can exist without the other. A publisher then
 * delivers each row to the audit service asynchronously and idempotently
 * (UNIQUE event_key), recording the real audit_event_id.
 *
 * This replaces the old emit-before-write ordering (which could orphan a
 * "completed" audit event while the job stayed 'purging') and the
 * 'audit-emit-failed' sentinel (a fake event id that let a job complete with no
 * real audit record).
 */

import { randomUUID } from "node:crypto";
import type { AuditEmitter, MetricsEmitter } from "@brain/shared";
import { brainId } from "@brain/shared";
import type { Pool } from "pg";
import type { Queryable } from "./blob-purge-repo.js";

/** Hard cap on audit-delivery attempts. Generous: losing audit evidence is worse
 *  than a noisy retry, so we keep trying well past a transient audit outage. */
export const MAX_OUTBOX_PUBLISH_ATTEMPTS = 12;

export interface AuditOutboxRow {
  id: string;
  /** Null for events not tied to a purge job (e.g. tenant.deleted). */
  job_id: string | null;
  tenant_id: string;
  action: string;
  payload: Record<string, unknown>;
  event_key: string;
  attempts: number;
  /** Event actor; null ⇒ delivery falls back to the worker id. */
  actor: string | null;
  /** Extra event inputs (merged into the delivered event's inputs). */
  inputs: Record<string, unknown>;
}

/** Exponential backoff for a failed audit delivery, capped at 480s. */
export function nextOutboxAttemptDelaySeconds(attempt: number): number {
  return Math.min(30 * 2 ** (attempt - 1), 480);
}

/**
 * Enqueue ONE audit-outbox row. MUST run inside the caller's transaction (the
 * same one that writes the job status), so the audit intent and the state change
 * are atomic. Idempotent on `event_key` (ON CONFLICT DO NOTHING): a logical
 * lifecycle event is enqueued at most once even across worker reclaims / retries.
 */
export async function enqueueAuditOutbox(
  client: Queryable,
  input: {
    jobId?: string | null;
    tenantId: string;
    action: string;
    payload: Record<string, unknown>;
    eventKey: string;
    /** Event actor. Omit for purge-lifecycle events (delivery uses the worker id). */
    actor?: string;
    /** Extra event inputs (e.g. requester). Defaults to {}. */
    inputs?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO tenant_blob_purge_audit_outbox
        (id, job_id, tenant_id, action, payload, event_key, actor, inputs)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb)
       ON CONFLICT (event_key) DO NOTHING`,
    [
      brainId("tbo"),
      input.jobId ?? null,
      input.tenantId,
      input.action,
      JSON.stringify(input.payload),
      input.eventKey,
      input.actor ?? null,
      JSON.stringify(input.inputs ?? {}),
    ],
  );
}

/** Claim up to `limit` pending, due rows under the attempt cap, locking them. */
export async function claimPendingAuditOutbox(
  client: Queryable,
  maxAttempts: number,
  limit: number,
): Promise<AuditOutboxRow[]> {
  const res = await client.query(
    `SELECT id, job_id, tenant_id, action, payload, event_key, attempts, actor, inputs
       FROM tenant_blob_purge_audit_outbox
      WHERE status = 'pending'
        AND next_attempt_at <= now()
        AND attempts < $1
      ORDER BY next_attempt_at
      LIMIT $2
      FOR UPDATE SKIP LOCKED`,
    [maxAttempts, limit],
  );
  return res.rows as AuditOutboxRow[];
}

export async function markAuditOutboxPublished(
  client: Queryable,
  id: string,
  auditEventId: string,
): Promise<void> {
  await client.query(
    `UPDATE tenant_blob_purge_audit_outbox
        SET status = 'published', audit_event_id = $2, published_at = now()
      WHERE id = $1`,
    [id, auditEventId],
  );
}

export async function markAuditOutboxFailed(
  client: Queryable,
  id: string,
  attempt: number,
  error: string,
  delaySeconds: number,
): Promise<void> {
  await client.query(
    `UPDATE tenant_blob_purge_audit_outbox
        SET attempts = $2, last_error = $3,
            next_attempt_at = now() + ($4 || ' seconds')::interval
      WHERE id = $1`,
    [id, attempt, error, String(delaySeconds)],
  );
}

/**
 * Terminal dead-letter at the attempt cap. Unlike {@link markAuditOutboxFailed},
 * this moves the row to an explicit `exhausted` state so it is NOT silently
 * pending-but-ineligible: mandatory audit evidence that could not be delivered is
 * observable (a critical metric is emitted alongside) and operator-replayable.
 */
export async function markAuditOutboxExhausted(
  client: Queryable,
  id: string,
  attempt: number,
  error: string,
): Promise<void> {
  await client.query(
    `UPDATE tenant_blob_purge_audit_outbox
        SET status = 'exhausted', attempts = $2, last_error = $3
      WHERE id = $1`,
    [id, attempt, error],
  );
}

/**
 * Operator replay: reset exhausted rows back to `pending` (attempts cleared, due
 * now) so the publisher re-attempts delivery on the next drain. Idempotent on the
 * audit side via the row's UNIQUE event_key. Returns the number requeued.
 */
export async function replayExhaustedAuditOutbox(client: Queryable, limit = 100): Promise<number> {
  const res = await client.query(
    `UPDATE tenant_blob_purge_audit_outbox
        SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
      WHERE id IN (
        SELECT id FROM tenant_blob_purge_audit_outbox
         WHERE status = 'exhausted'
         ORDER BY created_at
         LIMIT $1
      )`,
    [limit],
  );
  return res.rowCount ?? 0;
}

/** Count rows in the given status (operator/readiness observability). */
export async function countAuditOutboxByStatus(
  client: Queryable,
  status: "pending" | "published" | "exhausted",
): Promise<number> {
  const res = await client.query(
    `SELECT count(*)::int AS n FROM tenant_blob_purge_audit_outbox WHERE status = $1`,
    [status],
  );
  const row = res.rows[0] as { n: number } | undefined;
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Operator recovery surface (Codex c96283d P2): inspect and replay exhausted
// audit-evidence rows, with the replay itself audited.
// ---------------------------------------------------------------------------

/** Operator filter for listing / replaying outbox rows. All clauses are AND-ed. */
export interface AuditOutboxFilter {
  tenantId?: string;
  eventKey?: string;
  id?: string;
  /** Only rows whose created_at is older than this many seconds. */
  olderThanSeconds?: number;
}

/** A non-sensitive row summary for operator inspection (no payload/inputs). */
export interface AuditOutboxRowSummary {
  id: string;
  tenant_id: string;
  event_key: string;
  action: string;
  status: "pending" | "published" | "exhausted";
  attempts: number;
  age_seconds: number;
}

/** Build the parameterized WHERE fragments shared by list + replay. */
function buildOutboxFilter(filter: AuditOutboxFilter | undefined, params: unknown[]): string[] {
  const clauses: string[] = [];
  if (filter?.tenantId !== undefined) {
    params.push(filter.tenantId);
    clauses.push(`tenant_id = $${params.length}`);
  }
  if (filter?.eventKey !== undefined) {
    params.push(filter.eventKey);
    clauses.push(`event_key = $${params.length}`);
  }
  if (filter?.id !== undefined) {
    params.push(filter.id);
    clauses.push(`id = $${params.length}`);
  }
  if (filter?.olderThanSeconds !== undefined) {
    params.push(String(filter.olderThanSeconds));
    clauses.push(`created_at < now() - ($${params.length} || ' seconds')::interval`);
  }
  return clauses;
}

/**
 * List outbox rows for operator inspection (dry-run before replay). Returns only
 * non-sensitive metadata — never the payload/inputs. Defaults to exhausted rows.
 */
export async function listAuditOutbox(
  client: Queryable,
  opts: {
    status?: "pending" | "published" | "exhausted";
    filter?: AuditOutboxFilter;
    limit?: number;
  } = {},
): Promise<AuditOutboxRowSummary[]> {
  const params: unknown[] = [opts.status ?? "exhausted"];
  const clauses = [`status = $1`, ...buildOutboxFilter(opts.filter, params)];
  params.push(opts.limit ?? 100);
  const res = await client.query(
    `SELECT id, tenant_id, event_key, action, status, attempts,
            extract(epoch FROM now() - created_at)::int AS age_seconds
       FROM tenant_blob_purge_audit_outbox
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at
      LIMIT $${params.length}`,
    params,
  );
  return res.rows as AuditOutboxRowSummary[];
}

export interface OperatorReplayDeps {
  privilegedPool: {
    connect: () => Promise<Queryable & { release: () => void }>;
  };
}

export interface OperatorReplayResult {
  dryRun: boolean;
  /** Rows that were (or, in dry-run, would be) requeued. */
  replayed: AuditOutboxRowSummary[];
}

/**
 * Audited operator replay: requeue exhausted rows matching `filter` AND enqueue
 * the `audit.outbox.replayed` evidence in the SAME transaction (one intent per
 * affected tenant), so the recovery action and its audit record commit
 * atomically. The existing drain then delivers that intent idempotently. This
 * avoids the post-commit emit, which could leave a replay unaudited if the audit
 * write failed after the requeue committed (Codex fca9ac8 P1 #3). Supports
 * dry-run (inspect with no mutation and no audit intent).
 *
 * `opts.evidence` is merged into every per-tenant audit intent's inputs, so the
 * recovery record is self-describing: the operator passes the exact filter, the
 * source commit, and any other context, and it lands in the durable audit event
 * alongside the operator + event_keys (Codex 307161b P2 #3).
 */
export async function operatorReplayExhaustedAuditOutbox(
  deps: OperatorReplayDeps,
  opts: {
    operator: string;
    filter?: AuditOutboxFilter;
    dryRun?: boolean;
    limit?: number;
    evidence?: Record<string, unknown>;
  },
): Promise<OperatorReplayResult> {
  const c = await deps.privilegedPool.connect();
  try {
    await c.query("BEGIN");
    const params: unknown[] = ["exhausted"];
    const clauses = [`status = $1`, ...buildOutboxFilter(opts.filter, params)];
    params.push(opts.limit ?? 100);
    const sel = await c.query(
      `SELECT id, tenant_id, event_key, action, status, attempts,
              extract(epoch FROM now() - created_at)::int AS age_seconds
         FROM tenant_blob_purge_audit_outbox
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at
        LIMIT $${params.length}
        FOR UPDATE`,
      params,
    );
    const rows = sel.rows as AuditOutboxRowSummary[];

    if (opts.dryRun === true || rows.length === 0) {
      await c.query("ROLLBACK");
      return { dryRun: opts.dryRun === true, replayed: rows };
    }

    await c.query(
      `UPDATE tenant_blob_purge_audit_outbox
          SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
        WHERE id = ANY($1)`,
      [rows.map((r) => r.id)],
    );

    // Enqueue the replay evidence per affected tenant IN THIS TRANSACTION. The
    // operation id makes each invocation's event_key unique (and deterministic
    // for the publisher's exactly-once delivery via the row's unique event_key).
    const operationId = randomUUID();
    const byTenant = new Map<string, AuditOutboxRowSummary[]>();
    for (const r of rows) {
      const list = byTenant.get(r.tenant_id) ?? [];
      list.push(r);
      byTenant.set(r.tenant_id, list);
    }
    for (const [tenantId, trows] of byTenant) {
      await enqueueAuditOutbox(c, {
        tenantId,
        action: "audit.outbox.replayed",
        payload: {},
        eventKey: `audit.outbox.replayed:${operationId}:${tenantId}`,
        actor: opts.operator,
        inputs: {
          ...(opts.evidence ?? {}),
          operator: opts.operator,
          operation_id: operationId,
          count: trows.length,
          event_keys: trows.map((r) => r.event_key),
        },
      });
    }

    await c.query("COMMIT");
    return { dryRun: false, replayed: rows };
  } catch (err) {
    try {
      await c.query("ROLLBACK");
    } catch {
      /* swallow — original error wins */
    }
    throw err;
  } finally {
    c.release();
  }
}

export interface AuditOutboxDrainDeps {
  privilegedPool: Pool;
  audit: AuditEmitter;
  metrics?: MetricsEmitter;
  workerId: string;
  maxAttempts?: number;
}

export interface AuditOutboxDrainResult {
  published: number;
  failed: number;
  /** Rows dead-lettered to `exhausted` this cycle (delivery cap hit). */
  exhausted: number;
}

function outboxRowToEvent(
  row: AuditOutboxRow,
  workerId: string,
): Parameters<AuditEmitter["emit"]>[0] {
  return {
    tenantId: row.tenant_id,
    layer: "audit",
    // Explicit actor for non-purge events (e.g. the deletion requester); the
    // purge-lifecycle rows carry no actor and fall back to the worker id.
    actor: row.actor ?? workerId,
    action: row.action,
    inputs: {
      ...(row.job_id !== null ? { tenant_blob_purge_job_id: row.job_id } : {}),
      ...row.inputs,
      event_key: row.event_key,
    },
    outputs: row.payload,
    // End-to-end idempotency: if delivery already wrote this event but the
    // publisher crashed before marking the row published, the retry returns the
    // existing event instead of duplicating it.
    idempotencyKey: row.event_key,
  };
}

/**
 * Publish one pending outbox row in its OWN transaction: claim (lock) → emit →
 * mark published → commit. Per-row isolation means a delivery failure on one row
 * never rolls back another's published mark. Returns the disposition.
 */
async function publishOneOutboxRow(
  deps: AuditOutboxDrainDeps,
  maxAttempts: number,
): Promise<"empty" | "published" | "failed" | "exhausted"> {
  const c = await deps.privilegedPool.connect();
  try {
    await c.query("BEGIN");
    const [row] = await claimPendingAuditOutbox(c, maxAttempts, 1);
    if (row === undefined) {
      await c.query("ROLLBACK");
      return "empty";
    }
    try {
      const ev = await deps.audit.emit(outboxRowToEvent(row, deps.workerId));
      await markAuditOutboxPublished(c, row.id, ev.id);
      await c.query("COMMIT");
      return "published";
    } catch (err) {
      const attempt = row.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= maxAttempts) {
        // Cap hit: dead-letter to an explicit, observable `exhausted` state
        // rather than leaving the row pending-but-ineligible. Mandatory audit
        // evidence that could not be delivered must be loud, not silent.
        await markAuditOutboxExhausted(c, row.id, attempt, message);
        await c.query("COMMIT");
        deps.metrics?.increment("brain.tenant.blob_purge.audit_outbox_exhausted.count", {
          tenant_id: row.tenant_id,
        });
        console.error(
          "[blob-purge-audit-outbox] audit delivery exhausted; mandatory evidence undelivered",
          { outbox_id: row.id, tenant_id: row.tenant_id, event_key: row.event_key, attempt },
        );
        return "exhausted";
      }
      await markAuditOutboxFailed(
        c,
        row.id,
        attempt,
        message,
        nextOutboxAttemptDelaySeconds(attempt),
      );
      await c.query("COMMIT");
      deps.metrics?.increment("brain.tenant.blob_purge.audit_publish_failed.count", {
        tenant_id: row.tenant_id,
      });
      return "failed";
    }
  } catch (err) {
    try {
      await c.query("ROLLBACK");
    } catch {
      /* swallow — original error wins */
    }
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Drain pending audit-outbox rows: deliver each to the audit service. Called at
 * the end of every purge cycle (and so retries failed deliveries on the next
 * tick). Bounded by `limit` per cycle.
 */
export async function drainAuditOutbox(
  deps: AuditOutboxDrainDeps,
  opts: { limit?: number } = {},
): Promise<AuditOutboxDrainResult> {
  const maxAttempts = deps.maxAttempts ?? MAX_OUTBOX_PUBLISH_ATTEMPTS;
  const limit = opts.limit ?? 50;
  const tally: AuditOutboxDrainResult = { published: 0, failed: 0, exhausted: 0 };
  for (let i = 0; i < limit; i += 1) {
    const disposition = await publishOneOutboxRow(deps, maxAttempts);
    if (disposition === "empty") break;
    if (disposition === "published") tally.published += 1;
    else if (disposition === "exhausted") tally.exhausted += 1;
    else tally.failed += 1;
  }
  return tally;
}

export interface AuditOutboxHealth {
  /** Rows still awaiting delivery. */
  pending: number;
  /** Rows dead-lettered at the delivery cap — mandatory audit evidence that was
   *  permanently abandoned. Any non-zero value is an operational red. */
  exhausted: number;
  /** Age of the oldest pending row, in seconds (0 when none). */
  oldestPendingAgeSeconds: number;
  /** Age of the oldest exhausted row, in seconds (0 when none). */
  oldestExhaustedAgeSeconds: number;
}

export interface AuditOutboxHealthDeps {
  privilegedPool: Pool;
  metrics?: MetricsEmitter;
  /**
   * Suppress the critical log on exhausted rows. The worker-cycle caller keeps
   * the loud default; a POLLED caller (the audit-health endpoint) sets this so
   * one bad state does not emit a critical log line per poll (Fable-5 F-3).
   */
  quiet?: boolean;
}

/**
 * Emit observable health for the audit-evidence outbox so a delivery backlog or
 * a dead-lettered (exhausted) mandatory audit row is visible before it becomes a
 * silent compliance gap. Mirrors the audit-consistency verifier: a read-only
 * snapshot, gauges, and a critical log when exhausted rows exist. Operators turn
 * the exhausted gauge into a red alert (the static production-readiness script
 * cannot, since it has no live DB).
 *
 * MUST run through the privileged (BYPASSRLS) pool: the counts span every tenant
 * and set no tenant scope, so on the request-path role they would see zero rows.
 */
export async function reportAuditOutboxHealth(
  deps: AuditOutboxHealthDeps,
): Promise<AuditOutboxHealth> {
  const res = await deps.privilegedPool.query<{
    pending: number;
    exhausted: number;
    oldest_pending_age_s: number;
    oldest_exhausted_age_s: number;
  }>(
    `SELECT
        count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'exhausted')::int AS exhausted,
        coalesce(
          extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'pending')), 0
        )::float8 AS oldest_pending_age_s,
        coalesce(
          extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'exhausted')), 0
        )::float8 AS oldest_exhausted_age_s
       FROM tenant_blob_purge_audit_outbox`,
  );
  const row = res.rows[0];
  const health: AuditOutboxHealth = {
    pending: Number(row?.pending ?? 0),
    exhausted: Number(row?.exhausted ?? 0),
    oldestPendingAgeSeconds: Number(row?.oldest_pending_age_s ?? 0),
    oldestExhaustedAgeSeconds: Number(row?.oldest_exhausted_age_s ?? 0),
  };

  deps.metrics?.gauge("brain.audit.outbox.pending.count", health.pending);
  deps.metrics?.gauge("brain.audit.outbox.exhausted.count", health.exhausted);
  deps.metrics?.gauge(
    "brain.audit.outbox.oldest_pending_age_seconds",
    health.oldestPendingAgeSeconds,
  );
  deps.metrics?.gauge(
    "brain.audit.outbox.oldest_exhausted_age_seconds",
    health.oldestExhaustedAgeSeconds,
  );

  if (health.exhausted > 0 && deps.quiet !== true) {
    console.error("[audit-outbox] exhausted mandatory audit-evidence rows present", {
      exhausted: health.exhausted,
      oldestExhaustedAgeSeconds: health.oldestExhaustedAgeSeconds,
    });
  }
  return health;
}
