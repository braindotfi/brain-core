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

import type { AuditEmitter, MetricsEmitter } from "@brain/shared";
import { brainId } from "@brain/shared";
import type { Pool } from "pg";
import type { Queryable } from "./blob-purge-repo.js";

/** Hard cap on audit-delivery attempts. Generous: losing audit evidence is worse
 *  than a noisy retry, so we keep trying well past a transient audit outage. */
export const MAX_OUTBOX_PUBLISH_ATTEMPTS = 12;

export interface AuditOutboxRow {
  id: string;
  job_id: string;
  tenant_id: string;
  action: string;
  payload: Record<string, unknown>;
  event_key: string;
  attempts: number;
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
    jobId: string;
    tenantId: string;
    action: string;
    payload: Record<string, unknown>;
    eventKey: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO tenant_blob_purge_audit_outbox (id, job_id, tenant_id, action, payload, event_key)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (event_key) DO NOTHING`,
    [
      brainId("tbo"),
      input.jobId,
      input.tenantId,
      input.action,
      JSON.stringify(input.payload),
      input.eventKey,
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
    `SELECT id, job_id, tenant_id, action, payload, event_key, attempts
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
}

function outboxRowToEvent(
  row: AuditOutboxRow,
  workerId: string,
): Parameters<AuditEmitter["emit"]>[0] {
  return {
    tenantId: row.tenant_id,
    layer: "audit",
    actor: workerId,
    action: row.action,
    inputs: { tenant_blob_purge_job_id: row.job_id, event_key: row.event_key },
    outputs: row.payload,
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
): Promise<"empty" | "published" | "failed"> {
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
  const tally: AuditOutboxDrainResult = { published: 0, failed: 0 };
  for (let i = 0; i < limit; i += 1) {
    const disposition = await publishOneOutboxRow(deps, maxAttempts);
    if (disposition === "empty") break;
    if (disposition === "published") tally.published += 1;
    else tally.failed += 1;
  }
  return tally;
}
