/**
 * Tenant blob purge worker (RFC 0003, GDPR Art. 17).
 *
 * Drains `tenant_blob_purge_jobs`: claims due jobs, calls
 * `BlobAdapter.purgeTenant(tenantId)` to erase the Raw bytes a deleted tenant
 * uploaded, and records the outcome with bounded retries + a dead-letter
 * (exhausted) state. Every lifecycle transition emits an audit event so the
 * erasure is provable on the chain (the tenant's rows are gone, but the audit
 * layer is retained).
 *
 * Connection model: the queue is for ALREADY-DELETED tenants, so there is no
 * live request scope — the worker uses the privileged (BYPASSRLS) pool and
 * drains cross-tenant, exactly like the outbox + webhook-dispatch workers.
 *
 * Legal holds: when purgeTenant reports paths it could not erase (WORM / legal
 * hold), the job terminates as `blocked_legal_hold` (NOT retried — a hold will
 * not clear on its own) with the paths surfaced for the release runbook.
 */

import type { AuditEmitter, BlobAdapter, MetricsEmitter } from "@brain/shared";
import type { Pool } from "pg";
import {
  claimDueBlobPurgeJobs,
  markBlobPurgeBlockedLegalHold,
  markBlobPurgeCompleted,
  markBlobPurgeExhausted,
  markBlobPurgeFailed,
  nextPurgeAttemptDelaySeconds,
  MAX_BLOB_PURGE_ATTEMPTS,
  type BlobPurgeJobRow,
} from "./blob-purge-repo.js";

export interface BlobPurgeWorkerDeps {
  /** Privileged Pool (BYPASSRLS): purge jobs belong to deleted tenants. */
  privilegedPool: Pool;
  blob: BlobAdapter;
  audit: AuditEmitter;
  metrics?: MetricsEmitter;
  workerId?: string;
  /** Override the attempt cap (defaults to MAX_BLOB_PURGE_ATTEMPTS). */
  maxAttempts?: number;
}

export interface BlobPurgeCycleResult {
  claimed: number;
  completed: number;
  blockedLegalHold: number;
  retried: number;
  exhausted: number;
}

async function emitLifecycle(
  deps: BlobPurgeWorkerDeps,
  job: BlobPurgeJobRow,
  action: string,
  outputs: Record<string, unknown>,
  workerId: string,
): Promise<string> {
  try {
    const ev = await deps.audit.emit({
      tenantId: job.tenant_id,
      layer: "audit",
      actor: workerId,
      action,
      inputs: { tenant_blob_purge_job_id: job.id, blob_prefix: job.blob_prefix },
      outputs,
    });
    return ev.id;
  } catch (err) {
    // An audit-emit failure must not strand the job in 'purging'; record a
    // sentinel and continue so the status transition still lands.
    console.warn("[blob-purge-worker] failed to emit lifecycle audit event", err);
    return "audit-emit-failed";
  }
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
  const workerId = deps.workerId ?? "tenant-blob-purge-worker";
  const limit = opts.limit ?? 10;

  const c = await deps.privilegedPool.connect();
  let claimed: BlobPurgeJobRow[];
  try {
    claimed = await claimDueBlobPurgeJobs(c, workerId, max, limit);
  } finally {
    c.release();
  }

  const tally: BlobPurgeCycleResult = {
    claimed: 0,
    completed: 0,
    blockedLegalHold: 0,
    retried: 0,
    exhausted: 0,
  };

  for (const job of claimed) {
    tally.claimed += 1;
    try {
      const result = await deps.blob.purgeTenant(job.tenant_id);
      if (result.failed.length === 0) {
        const ev = await emitLifecycle(
          deps,
          job,
          "tenant_blob.purge_completed",
          { deleted: result.deleted },
          workerId,
        );
        await markBlobPurgeCompleted(deps.privilegedPool, job.id, result.deleted, ev);
        tally.completed += 1;
      } else {
        deps.metrics?.increment("brain.tenant.blob_purge.legal_hold.count", {
          tenant_id: job.tenant_id,
        });
        const ev = await emitLifecycle(
          deps,
          job,
          "tenant_blob.purge_blocked_legal_hold",
          { deleted: result.deleted, legal_hold_paths: result.failed },
          workerId,
        );
        await markBlobPurgeBlockedLegalHold(
          deps.privilegedPool,
          job.id,
          result.deleted,
          result.failed,
          ev,
        );
        tally.blockedLegalHold += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempt = job.attempts + 1;
      if (attempt >= max) {
        deps.metrics?.increment("brain.tenant.blob_purge.exhausted.count", {
          tenant_id: job.tenant_id,
        });
        const ev = await emitLifecycle(
          deps,
          job,
          "tenant_blob.purge_exhausted",
          { attempt, last_error: message },
          workerId,
        );
        await markBlobPurgeExhausted(deps.privilegedPool, job.id, attempt, message, ev);
        tally.exhausted += 1;
      } else {
        const delay = nextPurgeAttemptDelaySeconds(attempt);
        const ev = await emitLifecycle(
          deps,
          job,
          "tenant_blob.purge_retried",
          { attempt, last_error: message, next_attempt_in_seconds: delay },
          workerId,
        );
        await markBlobPurgeFailed(deps.privilegedPool, job.id, attempt, message, delay, ev);
        tally.retried += 1;
      }
    }
  }

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
