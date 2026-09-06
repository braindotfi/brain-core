import type { Pool, PoolClient } from "pg";
import {
  leasedCycle,
  startManagedInterval,
  type ManagedWorker,
  type MetricsEmitter,
} from "@brain/shared";
import {
  claimTenantDeletionJob,
  PROTECTED_TENANT_IDS,
  type TenantDeletionJobRow,
} from "./admin-delete.js";
import { assertTenantDeletionPrivilegeContract } from "./privilege-contract.js";
import { PRESERVED_TABLES, TENANT_SCOPED_TABLES, tenantDeleteStatement } from "./service.js";
import {
  assertTenantReconciliationEmpty,
  captureTenantReconciliationCounts,
  type TenantReconciliationTable,
} from "./per-tenant-retirement.js";
import { enqueueBlobPurgeJob } from "./blob-purge-repo.js";
import { enqueueAuditOutbox } from "./blob-purge-audit-outbox.js";

const WORKER_LOCK = "brain_worker_tenant_deletion";
const DELETE_TABLES: readonly TenantReconciliationTable[] = [
  ...TENANT_SCOPED_TABLES,
  { table: "tenants", column: "id" },
];
const AUDIT_TABLES: readonly TenantReconciliationTable[] = [
  { table: "audit_events", column: "tenant_id" },
  { table: "audit_anchors", column: "tenant_id" },
  { table: "audit_integrity_findings", column: "tenant_id" },
];

export interface TenantDeletionWorkerDeps {
  pool: Pool;
  metrics?: MetricsEmitter;
  workerId?: string;
}

interface AgentSnapshot {
  id: string;
  state: string;
}

async function claim(pool: Pool, workerId: string): Promise<TenantDeletionJobRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await claimTenantDeletionJob(client, workerId);
    await client.query("COMMIT");
    return job;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function fenceTenant(pool: Pool, job: TenantDeletionJobRow): Promise<AgentSnapshot[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const saved = job.agent_state_snapshot;
    const rows =
      saved !== undefined && saved !== null
        ? { rows: saved }
        : await client.query<AgentSnapshot>(
            `SELECT id, state FROM agents WHERE tenant_id = $1 ORDER BY id FOR UPDATE`,
            [job.tenant_id],
          );
    await client.query(
      `UPDATE agents SET state = 'quarantined' WHERE tenant_id = $1 AND state <> 'quarantined'`,
      [job.tenant_id],
    );
    await client.query(
      `UPDATE tenant_deletion_jobs
          SET status = 'deleting', agent_state_snapshot = $2::jsonb,
              locked_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'fencing'`,
      [job.id, JSON.stringify(rows.rows)],
    );
    await client.query("COMMIT");
    return rows.rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function restoreTenantFence(
  pool: Pool,
  tenantId: string,
  snapshot: readonly AgentSnapshot[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const agent of snapshot) {
      await client.query(`UPDATE agents SET state = $3 WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        agent.id,
        agent.state,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function markFailed(pool: Pool, jobId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(
    `UPDATE tenant_deletion_jobs
        SET status = 'failed', last_error = $2, completed_at = now(),
            locked_at = NULL, locked_by = NULL, updated_at = now()
      WHERE id = $1`,
    [jobId, message.slice(0, 4000)],
  );
}

async function executeDeletion(client: PoolClient, job: TenantDeletionJobRow): Promise<void> {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '45s'");
    await assertTenantDeletionPrivilegeContract(
      client,
      TENANT_SCOPED_TABLES.map(({ table }) => table),
    );
    const tenant = await client.query<{ do_not_delete: boolean }>(
      `SELECT do_not_delete FROM tenants WHERE id = $1 FOR UPDATE`,
      [job.tenant_id],
    );
    if (
      tenant.rows[0] === undefined ||
      tenant.rows[0].do_not_delete ||
      PROTECTED_TENANT_IDS.has(job.tenant_id)
    ) {
      throw new Error("tenant disappeared or became protected after enqueue");
    }

    const expected = await captureTenantReconciliationCounts(client, DELETE_TABLES, job.tenant_id);
    const preservedBefore = await captureTenantReconciliationCounts(
      client,
      AUDIT_TABLES,
      job.tenant_id,
    );
    const blobs = await client.query<{ blob_uri: string }>(
      `SELECT blob_uri FROM raw_artifacts
        WHERE tenant_id = $1 AND blob_uri IS NOT NULL
        ORDER BY blob_uri`,
      [job.tenant_id],
    );
    let purgeJobId: string | null = null;
    if (blobs.rows.length > 0) {
      purgeJobId = await enqueueBlobPurgeJob(client, {
        tenantId: job.tenant_id,
        blobPrefix: `${job.tenant_id}/`,
        blobArtifactCount: blobs.rows.length,
      });
      if (purgeJobId === null) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM tenant_blob_purge_jobs WHERE tenant_id = $1`,
          [job.tenant_id],
        );
        purgeJobId = existing.rows[0]?.id ?? null;
      }
    }

    const deleted: Record<string, number> = {};
    let total = 0;
    for (const { table, column } of TENANT_SCOPED_TABLES) {
      const result = await client.query(tenantDeleteStatement(table, column), [job.tenant_id]);
      const count = result.rowCount ?? 0;
      if (count !== expected[table]) {
        throw new Error(
          `tenant deletion count mismatch for ${table}: ${count} != ${expected[table]}`,
        );
      }
      deleted[table] = count;
      total += count;
    }
    const tenantDelete = await client.query(tenantDeleteStatement("tenants", "id"), [
      job.tenant_id,
    ]);
    const tenantCount = tenantDelete.rowCount ?? 0;
    if (tenantCount !== expected["tenants"]) throw new Error("tenant row count mismatch");
    deleted["tenants"] = tenantCount;
    total += tenantCount;
    await assertTenantReconciliationEmpty(client, DELETE_TABLES, job.tenant_id);
    const preservedAfter = await captureTenantReconciliationCounts(
      client,
      AUDIT_TABLES,
      job.tenant_id,
    );
    if (JSON.stringify(preservedAfter) !== JSON.stringify(preservedBefore)) {
      throw new Error("preserved audit count changed during tenant deletion");
    }

    const status = purgeJobId === null ? "completed" : "purging_blobs";
    await client.query(
      `UPDATE tenant_deletion_jobs
          SET status = $2, expected_rows = $3::jsonb, deleted_rows = $4::jsonb,
              total_rows_deleted = $5, blob_purge_job_id = $6,
              blob_artifact_count = $7, last_error = NULL,
              locked_at = NULL, locked_by = NULL,
              completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE NULL END,
              updated_at = now()
        WHERE id = $1`,
      [
        job.id,
        status,
        JSON.stringify(expected),
        JSON.stringify(deleted),
        total,
        purgeJobId,
        blobs.rows.length,
      ],
    );
    await enqueueAuditOutbox(client, {
      jobId: purgeJobId ?? job.id,
      tenantId: job.tenant_id,
      action: "tenant.deleted",
      payload: {
        deletion_job_id: job.id,
        total_rows_deleted: total,
        per_table_counts: deleted,
        preserved: [...PRESERVED_TABLES].sort(),
        blob_artifact_count: blobs.rows.length,
        blob_purge_job_id: purgeJobId,
      },
      eventKey: `${job.id}:tenant.deleted`,
      actor: job.requested_by,
      inputs: { tenant_id: job.tenant_id, requested_by: job.requested_by },
    });
    if (purgeJobId !== null) {
      await enqueueAuditOutbox(client, {
        jobId: purgeJobId,
        tenantId: job.tenant_id,
        action: "tenant_blob.purge_requested",
        payload: { blob_prefix: `${job.tenant_id}/`, blob_artifact_count: blobs.rows.length },
        eventKey: `${job.id}:tenant_blob.purge_requested`,
        actor: job.requested_by,
      });
    } else {
      await enqueueAuditOutbox(client, {
        jobId: job.id,
        tenantId: job.tenant_id,
        action: "tenant.delete_completed",
        payload: { deletion_job_id: job.id, total_rows_deleted: total, blobs_deleted: 0 },
        eventKey: `${job.id}:tenant.delete_completed`,
        actor: job.requested_by,
      });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function runTenantDeletionCycle(deps: TenantDeletionWorkerDeps): Promise<boolean> {
  const workerId = deps.workerId ?? `tenant-deletion-worker-${process.pid}`;
  const job = await claim(deps.pool, workerId);
  if (job === null) return false;
  let snapshot: AgentSnapshot[] = [];
  try {
    snapshot = await fenceTenant(deps.pool, job);
    const client = await deps.pool.connect();
    try {
      await executeDeletion(client, job);
    } finally {
      client.release();
    }
    deps.metrics?.increment("brain.tenant.deletion.completed", { tenant_id: job.tenant_id });
  } catch (error) {
    await restoreTenantFence(deps.pool, job.tenant_id, snapshot).catch((restoreError) => {
      console.error("[tenant-deletion-worker] failed to restore tenant fence", restoreError);
    });
    await markFailed(deps.pool, job.id, error);
    deps.metrics?.increment("brain.tenant.deletion.failed", { tenant_id: job.tenant_id });
  }
  return true;
}

export function startAdminTenantDeletionWorker(
  deps: TenantDeletionWorkerDeps,
  opts: { intervalMs?: number } = {},
): ManagedWorker {
  const cycle = leasedCycle({
    pool: deps.pool,
    lockKey: WORKER_LOCK,
    name: "tenant-deletion",
    metrics: deps.metrics,
    cycle: async () => {
      await runTenantDeletionCycle(deps);
    },
  });
  return startManagedInterval(cycle, opts.intervalMs ?? 5_000, {
    name: "tenant-deletion",
    onError: (error) => console.error("[tenant-deletion-worker] cycle failed", error),
  });
}
