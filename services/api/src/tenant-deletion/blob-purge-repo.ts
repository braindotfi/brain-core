/**
 * Repository for the durable tenant blob purge queue (RFC 0003, GDPR Art. 17).
 *
 * Pure SQL helpers over `tenant_blob_purge_jobs`. The enqueue runs inside the
 * tenant-deletion transaction (privileged); the claim + status transitions run
 * from the privileged worker. RLS is bypassed by the worker's role because a
 * purge job belongs to an already-DELETED tenant (no live request scope).
 */

import { brainId } from "@brain/shared";

/** Minimal pg-compatible query surface (real PoolClient or a test fake). */
export interface Queryable {
  query: (
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** Hard cap on retry attempts before a job is dead-lettered (exhausted). */
export const MAX_BLOB_PURGE_ATTEMPTS = 6;

export type BlobPurgeStatus =
  | "pending"
  | "purging"
  | "completed"
  | "failed"
  | "exhausted"
  | "blocked_legal_hold";

export interface BlobPurgeJobRow {
  id: string;
  tenant_id: string;
  blob_prefix: string;
  blob_artifact_count: number;
  status: BlobPurgeStatus;
  attempts: number;
}

/**
 * Exponential backoff for a failed purge, capped. `attempt` is the NEW attempt
 * count (1-based): 30s, 60s, 120s, 240s, then 480s for everything after.
 * Mirrors the webhook dead-letter worker's schedule.
 */
export function nextPurgeAttemptDelaySeconds(attempt: number): number {
  const base = 30 * 2 ** (attempt - 1);
  return Math.min(base, 480);
}

/**
 * Enqueue ONE purge job for a tenant deletion. Idempotent on tenant_id
 * (ON CONFLICT DO NOTHING): a tenant is deleted at most once, and a retry of the
 * deletion must not create a second job. Returns the new job id, or null when a
 * job already existed. MUST be called inside the deletion transaction.
 */
export async function enqueueBlobPurgeJob(
  client: Queryable,
  input: { tenantId: string; blobPrefix: string; blobArtifactCount: number },
): Promise<string | null> {
  const id = brainId("tbp");
  const res = await client.query(
    `INSERT INTO tenant_blob_purge_jobs (id, tenant_id, blob_prefix, blob_artifact_count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id) DO NOTHING
       RETURNING id`,
    [id, input.tenantId, input.blobPrefix, input.blobArtifactCount],
  );
  const row = res.rows[0] as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Atomically claim up to `limit` due jobs: flip pending/failed → purging, stamp
 * the lock columns, and return them. `FOR UPDATE SKIP LOCKED` lets concurrent
 * workers claim disjoint sets without blocking. Only rows under the attempt cap
 * and past their next_attempt_at are eligible.
 */
export async function claimDueBlobPurgeJobs(
  client: Queryable,
  workerId: string,
  maxAttempts: number,
  limit = 10,
): Promise<BlobPurgeJobRow[]> {
  const res = await client.query(
    `UPDATE tenant_blob_purge_jobs
        SET status = 'purging', locked_at = now(), locked_by = $1
      WHERE id IN (
        SELECT id FROM tenant_blob_purge_jobs
         WHERE status IN ('pending', 'failed')
           AND next_attempt_at <= now()
           AND attempts < $2
         ORDER BY next_attempt_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, tenant_id, blob_prefix, blob_artifact_count, status, attempts`,
    [workerId, maxAttempts, limit],
  );
  return res.rows as BlobPurgeJobRow[];
}

export async function markBlobPurgeCompleted(
  client: Queryable,
  id: string,
  deletedCount: number,
  auditEventId: string,
): Promise<void> {
  await client.query(
    `UPDATE tenant_blob_purge_jobs
        SET status = 'completed', deleted_count = $2, completed_at = now(),
            locked_at = NULL, locked_by = NULL,
            audit_event_ids = array_append(audit_event_ids, $3)
      WHERE id = $1`,
    [id, deletedCount, auditEventId],
  );
}

/**
 * Terminal state when the purge ran but some objects could NOT be erased because
 * of a WORM / legal hold. Surfaced (not retried — a hold will not clear on its
 * own); an operator runs the legal-hold-release runbook.
 */
export async function markBlobPurgeBlockedLegalHold(
  client: Queryable,
  id: string,
  deletedCount: number,
  legalHoldPaths: ReadonlyArray<string>,
  auditEventId: string,
): Promise<void> {
  await client.query(
    `UPDATE tenant_blob_purge_jobs
        SET status = 'blocked_legal_hold', deleted_count = $2, legal_hold_paths = $3,
            completed_at = now(), locked_at = NULL, locked_by = NULL,
            audit_event_ids = array_append(audit_event_ids, $4)
      WHERE id = $1`,
    [id, deletedCount, [...legalHoldPaths], auditEventId],
  );
}

/** Transient failure: schedule a backoff retry (status back to 'failed'). */
export async function markBlobPurgeFailed(
  client: Queryable,
  id: string,
  attempt: number,
  error: string,
  delaySeconds: number,
  auditEventId: string,
): Promise<void> {
  await client.query(
    `UPDATE tenant_blob_purge_jobs
        SET status = 'failed', attempts = $2, last_error = $3,
            next_attempt_at = now() + ($4 || ' seconds')::interval,
            locked_at = NULL, locked_by = NULL,
            audit_event_ids = array_append(audit_event_ids, $5)
      WHERE id = $1`,
    [id, attempt, error, String(delaySeconds), auditEventId],
  );
}

/** Hard giveup at the attempt cap: dead-letter (exhausted), no further retries. */
export async function markBlobPurgeExhausted(
  client: Queryable,
  id: string,
  attempt: number,
  error: string,
  auditEventId: string,
): Promise<void> {
  await client.query(
    `UPDATE tenant_blob_purge_jobs
        SET status = 'exhausted', attempts = $2, last_error = $3, completed_at = now(),
            locked_at = NULL, locked_by = NULL,
            audit_event_ids = array_append(audit_event_ids, $4)
      WHERE id = $1`,
    [id, attempt, error, auditEventId],
  );
}
