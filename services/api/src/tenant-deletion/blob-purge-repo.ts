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

/**
 * How long a claimed ('purging') job's lease is honoured before another worker
 * may reclaim it (review P1 #1). Must comfortably exceed the worst-case
 * purgeTenant duration so a slow-but-healthy purge is not reclaimed out from
 * under itself; fenced writes (locked_by) make a concurrent double-claim safe
 * even if it does happen. 15 minutes.
 */
export const BLOB_PURGE_LEASE_SECONDS = 900;

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
  /**
   * True when this row was reclaimed from an expired lease (a previous worker
   * claimed it and never reached a terminal state). The worker emits a
   * `tenant_blob.purge_reclaimed` audit event + metric for these so a crashed /
   * stuck worker is observable rather than silent.
   */
  reclaimed: boolean;
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
 * Atomically claim up to `limit` jobs and stamp them with the caller's unique
 * `lockToken`. Two kinds of row are eligible (review P1 #1):
 *
 *   1. DUE work: status IN ('pending','failed') AND next_attempt_at <= now().
 *   2. STALE LEASES: status = 'purging' AND locked_at older than `leaseSeconds`
 *      — a previous worker claimed it and never reached a terminal state (it
 *      crashed, or its DB write was lost). Without this the row would sit in
 *      'purging' forever; the claim only ever looked at pending/failed.
 *
 * `FOR UPDATE SKIP LOCKED` lets concurrent workers claim disjoint sets. Only
 * rows under the attempt cap are eligible. The returned `reclaimed` flag marks
 * rows that came from case 2 so the worker can emit a reclaim audit + metric.
 *
 * Reclaiming does NOT bump `attempts`: a lease expiry is not a purge failure
 * (purgeTenant is idempotent — a re-run erases the remainder), so a transient
 * crash must not march a healthy job toward the dead-letter. Real purge errors
 * still increment `attempts` via the worker's failure path, which bounds poison
 * jobs. The unique `lockToken` (not a static worker name) is what every
 * subsequent status write is fenced on, so a resurrected stale worker cannot
 * clobber the new owner's result.
 */
export async function claimDueBlobPurgeJobs(
  client: Queryable,
  lockToken: string,
  maxAttempts: number,
  leaseSeconds: number,
  limit = 10,
): Promise<BlobPurgeJobRow[]> {
  const res = await client.query(
    `WITH due AS (
        SELECT id, status AS prev_status
          FROM tenant_blob_purge_jobs
         WHERE attempts < $2
           AND (
             (status IN ('pending', 'failed') AND next_attempt_at <= now())
             OR (status = 'purging' AND locked_at < now() - ($3 || ' seconds')::interval)
           )
         ORDER BY next_attempt_at
         LIMIT $4
         FOR UPDATE SKIP LOCKED
      )
      UPDATE tenant_blob_purge_jobs t
         SET status = 'purging', locked_at = now(), locked_by = $1
        FROM due
       WHERE t.id = due.id
      RETURNING t.id, t.tenant_id, t.blob_prefix, t.blob_artifact_count, t.status, t.attempts,
                (due.prev_status = 'purging') AS reclaimed`,
    [lockToken, maxAttempts, String(leaseSeconds), limit],
  );
  return res.rows as BlobPurgeJobRow[];
}

/**
 * Every terminal/retry write is FENCED on `lockToken`: the `WHERE locked_by =
 * $token` clause means a worker whose lease was reclaimed (locked_by replaced by
 * the new owner) updates 0 rows, so it cannot overwrite the new owner's result
 * (review P1 #1, item 5). Returns true when the lease was still held (1 row
 * written), false when it had been stolen.
 */
export async function markBlobPurgeCompleted(
  client: Queryable,
  id: string,
  deletedCount: number,
  lockToken: string,
): Promise<boolean> {
  const res = await client.query(
    `UPDATE tenant_blob_purge_jobs
        SET status = 'completed', deleted_count = $2, completed_at = now(),
            locked_at = NULL, locked_by = NULL
      WHERE id = $1 AND locked_by = $3`,
    [id, deletedCount, lockToken],
  );
  return (res.rowCount ?? 0) > 0;
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
  lockToken: string,
): Promise<boolean> {
  const res = await client.query(
    `UPDATE tenant_blob_purge_jobs
        SET status = 'blocked_legal_hold', deleted_count = $2, legal_hold_paths = $3,
            completed_at = now(), locked_at = NULL, locked_by = NULL
      WHERE id = $1 AND locked_by = $4`,
    [id, deletedCount, [...legalHoldPaths], lockToken],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Transient failure: schedule a backoff retry (status back to 'failed'). */
export async function markBlobPurgeFailed(
  client: Queryable,
  id: string,
  attempt: number,
  error: string,
  delaySeconds: number,
  lockToken: string,
): Promise<boolean> {
  const res = await client.query(
    `UPDATE tenant_blob_purge_jobs
        SET status = 'failed', attempts = $2, last_error = $3,
            next_attempt_at = now() + ($4 || ' seconds')::interval,
            locked_at = NULL, locked_by = NULL
      WHERE id = $1 AND locked_by = $5`,
    [id, attempt, error, String(delaySeconds), lockToken],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Hard giveup at the attempt cap: dead-letter (exhausted), no further retries. */
export async function markBlobPurgeExhausted(
  client: Queryable,
  id: string,
  attempt: number,
  error: string,
  lockToken: string,
): Promise<boolean> {
  const res = await client.query(
    `UPDATE tenant_blob_purge_jobs
        SET status = 'exhausted', attempts = $2, last_error = $3, completed_at = now(),
            locked_at = NULL, locked_by = NULL
      WHERE id = $1 AND locked_by = $4`,
    [id, attempt, error, lockToken],
  );
  return (res.rowCount ?? 0) > 0;
}
