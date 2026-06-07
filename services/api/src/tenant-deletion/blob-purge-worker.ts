/**
 * Tenant blob purge worker (RFC 0003, GDPR Art. 17).
 *
 * Drains `tenant_blob_purge_jobs`: claims due jobs, calls
 * `BlobAdapter.purgeTenant(tenantId)` to erase the Raw bytes a deleted tenant
 * uploaded, and records the outcome with bounded retries + a dead-letter
 * (exhausted) state.
 *
 * Connection model: the queue is for ALREADY-DELETED tenants, so there is no
 * live request scope — the worker uses the privileged (BYPASSRLS) pool and
 * drains cross-tenant, exactly like the outbox + webhook-dispatch workers.
 *
 * Lease recovery (review P1 #1): each cycle stamps a unique lock token and every
 * status write is fenced on it; stale 'purging' leases are reclaimed so a crashed
 * worker cannot strand a job.
 *
 * Failure classification (review P1 #2): purgeTenant returns CLASSIFIED failures.
 * Transient / authorization / unknown errors are RETRIED (purgeTenant is
 * idempotent) and bounded by the attempt cap. Only when every remaining failure
 * is a confirmed legal hold (WORM / object-lock) does the job terminate as
 * `blocked_legal_hold`. A 503 or expired credential no longer masquerades as one.
 *
 * Transactional audit (review P2 #1): every lifecycle transition writes its audit
 * INTENT to `tenant_blob_purge_audit_outbox` in the SAME transaction as the
 * status change (atomic — neither can exist without the other), and a publisher
 * drained at the end of each cycle delivers it to the audit service idempotently.
 * No more emit-before-write orphans and no more 'audit-emit-failed' sentinel.
 */

import { randomUUID } from "node:crypto";
import type { AuditEmitter, BlobAdapter, BlobPurgeFailure, MetricsEmitter } from "@brain/shared";
import type { Pool } from "pg";
import {
  BLOB_PURGE_LEASE_SECONDS,
  claimDueBlobPurgeJobs,
  markBlobPurgeBlockedLegalHold,
  markBlobPurgeCompleted,
  markBlobPurgeExhausted,
  markBlobPurgeFailed,
  nextPurgeAttemptDelaySeconds,
  MAX_BLOB_PURGE_ATTEMPTS,
  type BlobPurgeJobRow,
  type Queryable,
} from "./blob-purge-repo.js";
import {
  drainAuditOutbox,
  enqueueAuditOutbox,
  reportAuditOutboxHealth,
} from "./blob-purge-audit-outbox.js";

export interface BlobPurgeWorkerDeps {
  /** Privileged Pool (BYPASSRLS): purge jobs belong to deleted tenants. */
  privilegedPool: Pool;
  blob: BlobAdapter;
  audit: AuditEmitter;
  metrics?: MetricsEmitter;
  workerId?: string;
  /** Override the attempt cap (defaults to MAX_BLOB_PURGE_ATTEMPTS). */
  maxAttempts?: number;
  /** Override the lease timeout in seconds (defaults to BLOB_PURGE_LEASE_SECONDS). */
  leaseSeconds?: number;
}

export interface BlobPurgeCycleResult {
  claimed: number;
  completed: number;
  blockedLegalHold: number;
  retried: number;
  exhausted: number;
  /** Stale-lease jobs reclaimed this cycle from a crashed/stuck prior worker. */
  reclaimed: number;
  /** Outcomes discarded because the lease was stolen mid-flight (fenced write). */
  leaseLost: number;
  /** Audit-outbox rows delivered to the audit service this cycle. */
  auditPublished: number;
  /** Audit-outbox rows whose delivery failed this cycle (will be retried). */
  auditFailed: number;
  /** Audit-outbox rows dead-lettered to `exhausted` this cycle (delivery cap hit). */
  auditExhausted: number;
}

/** Human-readable summary of a mixed failure batch for the retry's last_error. */
function summarizeFailures(failures: ReadonlyArray<BlobPurgeFailure>): string {
  const counts = new Map<string, number>();
  for (const f of failures) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  const parts = [...counts.entries()].map(([cat, n]) => `${n} ${cat}`);
  return `${failures.length} object(s) could not be erased (${parts.join(", ")}); retrying`;
}

/**
 * Run a single drain cycle. Exported so tests drive it directly with no timers;
 * {@link startTenantBlobPurgeWorker} just polls this.
 */
export async function runBlobPurgeCycle(
  deps: BlobPurgeWorkerDeps,
  opts: { limit?: number } = {},
): Promise<BlobPurgeCycleResult> {
  const max = deps.maxAttempts ?? MAX_BLOB_PURGE_ATTEMPTS;
  const lease = deps.leaseSeconds ?? BLOB_PURGE_LEASE_SECONDS;
  const workerId = deps.workerId ?? "tenant-blob-purge-worker";
  // A UNIQUE token per cycle (not the static worker name) is what every status
  // write below is fenced on. If this job's lease is later reclaimed, the new
  // owner stamps a different token and our fenced writes no-op — so a resurrected
  // stale worker cannot clobber the new owner's result (review P1 #1).
  const lockToken = `${workerId}:${randomUUID()}`;
  const limit = opts.limit ?? 10;

  const c = await deps.privilegedPool.connect();
  let claimed: BlobPurgeJobRow[];
  try {
    claimed = await claimDueBlobPurgeJobs(c, lockToken, max, lease, limit);
  } finally {
    c.release();
  }

  const tally: BlobPurgeCycleResult = {
    claimed: 0,
    completed: 0,
    blockedLegalHold: 0,
    retried: 0,
    exhausted: 0,
    reclaimed: 0,
    leaseLost: 0,
    auditPublished: 0,
    auditFailed: 0,
    auditExhausted: 0,
  };

  // A fenced write returned false ⇒ another worker reclaimed this job's lease
  // mid-flight; our outcome is stale and was NOT applied. Record + move on.
  const onLeaseLost = (job: BlobPurgeJobRow): void => {
    tally.leaseLost += 1;
    deps.metrics?.increment("brain.tenant.blob_purge.lease_lost.count", {
      tenant_id: job.tenant_id,
    });
    console.warn(
      "[blob-purge-worker] lease lost (reclaimed by another worker); discarding outcome",
      { job_id: job.id },
    );
  };

  // Apply a terminal/retry status transition AND enqueue its audit intent in ONE
  // transaction (review P2 #1): atomic, fenced on the lease. Returns whether the
  // lease was still held (the write landed).
  const commitTransition = async (
    job: BlobPurgeJobRow,
    action: string,
    payload: Record<string, unknown>,
    eventKey: string,
    mark: (client: Queryable) => Promise<boolean>,
  ): Promise<boolean> => {
    const conn = await deps.privilegedPool.connect();
    try {
      await conn.query("BEGIN");
      const held = await mark(conn);
      if (!held) {
        await conn.query("ROLLBACK");
        return false;
      }
      await enqueueAuditOutbox(conn, {
        jobId: job.id,
        tenantId: job.tenant_id,
        action,
        payload,
        eventKey,
      });
      await conn.query("COMMIT");
      return true;
    } catch (err) {
      try {
        await conn.query("ROLLBACK");
      } catch {
        /* swallow — original error wins */
      }
      throw err;
    } finally {
      conn.release();
    }
  };

  const retryOrExhaust = async (job: BlobPurgeJobRow, message: string): Promise<void> => {
    const attempt = job.attempts + 1;
    if (attempt >= max) {
      deps.metrics?.increment("brain.tenant.blob_purge.exhausted.count", {
        tenant_id: job.tenant_id,
      });
      const eventKey = `${job.id}:tenant_blob.purge_exhausted:${attempt}`;
      const held = await commitTransition(
        job,
        "tenant_blob.purge_exhausted",
        { attempt, last_error: message },
        eventKey,
        (conn) => markBlobPurgeExhausted(conn, job.id, attempt, message, lockToken),
      );
      if (held) tally.exhausted += 1;
      else onLeaseLost(job);
    } else {
      const delay = nextPurgeAttemptDelaySeconds(attempt);
      const eventKey = `${job.id}:tenant_blob.purge_retried:${attempt}`;
      const held = await commitTransition(
        job,
        "tenant_blob.purge_retried",
        { attempt, last_error: message, next_attempt_in_seconds: delay },
        eventKey,
        (conn) => markBlobPurgeFailed(conn, job.id, attempt, message, delay, lockToken),
      );
      if (held) tally.retried += 1;
      else onLeaseLost(job);
    }
  };

  for (const job of claimed) {
    tally.claimed += 1;
    // Observability for crash recovery: a reclaimed job means a prior worker
    // claimed it and never reached a terminal state. The reclaim audit event has
    // no state change, so it is enqueued on its own (idempotent on event_key).
    if (job.reclaimed) {
      tally.reclaimed += 1;
      deps.metrics?.increment("brain.tenant.blob_purge.reclaimed.count", {
        tenant_id: job.tenant_id,
      });
      await enqueueAuditOutbox(deps.privilegedPool, {
        jobId: job.id,
        tenantId: job.tenant_id,
        action: "tenant_blob.purge_reclaimed",
        payload: { attempts: job.attempts },
        eventKey: `${job.id}:tenant_blob.purge_reclaimed:${job.attempts}`,
      });
    }
    try {
      const result = await deps.blob.purgeTenant(job.tenant_id);
      const { failures } = result;
      if (failures.length === 0) {
        const eventKey = `${job.id}:tenant_blob.purge_completed:${job.attempts}`;
        const held = await commitTransition(
          job,
          "tenant_blob.purge_completed",
          { deleted: result.deleted },
          eventKey,
          (conn) => markBlobPurgeCompleted(conn, job.id, result.deleted, lockToken),
        );
        if (held) tally.completed += 1;
        else onLeaseLost(job);
      } else {
        // Per-category metric so transient / authorization / legal_hold / unknown
        // are distinguishable on the dashboard (review P1 #2).
        for (const f of failures) {
          deps.metrics?.increment("brain.tenant.blob_purge.failure.count", {
            tenant_id: job.tenant_id,
            category: f.category,
          });
        }
        const retryable = failures.filter((f) => f.retryable);
        if (retryable.length > 0) {
          // Some objects can still be erased on a later run (transient cloud
          // error / authorization / unknown). Retry the WHOLE job — purgeTenant
          // is idempotent — instead of burning it to a terminal legal hold over
          // a 503. Any genuine legal holds in this batch are re-encountered on
          // the next run and only become terminal once they are ALL that remain.
          await retryOrExhaust(job, summarizeFailures(failures));
        } else {
          // Only confirmed legal holds remain (nothing retryable) → terminal.
          const legalHoldPaths = failures.map((f) => f.path);
          deps.metrics?.increment("brain.tenant.blob_purge.legal_hold.count", {
            tenant_id: job.tenant_id,
          });
          const eventKey = `${job.id}:tenant_blob.purge_blocked_legal_hold:${job.attempts}`;
          const held = await commitTransition(
            job,
            "tenant_blob.purge_blocked_legal_hold",
            { deleted: result.deleted, legal_hold_paths: legalHoldPaths },
            eventKey,
            (conn) =>
              markBlobPurgeBlockedLegalHold(
                conn,
                job.id,
                result.deleted,
                legalHoldPaths,
                lockToken,
              ),
          );
          if (held) tally.blockedLegalHold += 1;
          else onLeaseLost(job);
        }
      }
    } catch (err) {
      // purgeTenant itself threw (e.g. a LIST error, not a per-object failure).
      await retryOrExhaust(job, err instanceof Error ? err.message : String(err));
    }
  }

  // Deliver this cycle's (and any previously-failed) audit intents. Runs every
  // tick so a transient audit outage self-heals on the next cycle.
  const drain = await drainAuditOutbox(
    {
      privilegedPool: deps.privilegedPool,
      audit: deps.audit,
      workerId,
      ...(deps.metrics !== undefined ? { metrics: deps.metrics } : {}),
    },
    { limit: 50 },
  );
  tally.auditPublished = drain.published;
  tally.auditFailed = drain.failed;
  tally.auditExhausted = drain.exhausted;

  // Emit observable health for the audit-evidence outbox (backlog + dead-letters)
  // so an exhausted mandatory audit row is alertable rather than silent.
  await reportAuditOutboxHealth({
    privilegedPool: deps.privilegedPool,
    ...(deps.metrics !== undefined ? { metrics: deps.metrics } : {}),
  });

  return tally;
}

/**
 * Long-running driver: poll {@link runBlobPurgeCycle} every `intervalMs` until
 * stop() is called. Unit tests drive runBlobPurgeCycle directly (no timers).
 */
export function startTenantBlobPurgeWorker(
  deps: BlobPurgeWorkerDeps,
  opts: { intervalMs?: number; limit?: number } = {},
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 30_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cycleOpts: { limit?: number } = {};
  if (opts.limit !== undefined) cycleOpts.limit = opts.limit;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await runBlobPurgeCycle(deps, cycleOpts);
    } catch (err) {
      console.error("[blob-purge-worker] cycle failed", err);
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  timer = setTimeout(() => void tick(), intervalMs);
  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
