import type { Pool, PoolClient } from "pg";
import { brainError, newTenantDeletionJobId } from "@brain/shared";
import { enqueueAuditOutbox } from "./blob-purge-audit-outbox.js";

export const PROTECTED_TENANT_IDS: ReadonlySet<string> = new Set([
  "tnt_00000000010000000000000000",
  "tnt_01KYAT7A1QRKHTYW9H4RAR2SEX",
  "tnt_01KYAT31JH0G043K77H8SKYG4N",
  "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ",
  "tnt_01M1GTBQN8R8PB6X6PN73YB6NP",
  "tnt_01M1M64ZE1R8J9TB6C3DCRKA61",
]);

export type TenantDeletionJobStatus =
  | "queued"
  | "fencing"
  | "deleting"
  | "purging_blobs"
  | "completed"
  | "failed";

export interface TenantDeletionJobRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  requested_by: string;
  status: TenantDeletionJobStatus;
  expected_rows: Record<string, number> | null;
  deleted_rows: Record<string, number> | null;
  total_rows_deleted: string | null;
  blob_purge_job_id: string | null;
  blob_artifact_count: number | null;
  last_error: string | null;
  agent_state_snapshot?: Array<{ id: string; state: string }> | null;
  created_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
}

export function tenantDeletionJobToWire(row: TenantDeletionJobRow) {
  return {
    job_id: row.id,
    tenant_id: row.tenant_id,
    status: row.status,
    counts: {
      expected: row.expected_rows,
      deleted: row.deleted_rows,
      total_deleted: row.total_rows_deleted === null ? null : Number(row.total_rows_deleted),
      blob_artifacts: row.blob_artifact_count,
    },
    error: row.last_error,
    created_at: new Date(row.created_at).toISOString(),
    started_at: row.started_at === null ? null : new Date(row.started_at).toISOString(),
    completed_at: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
  };
}

export class AdminTenantDeletionService {
  public constructor(private readonly pool: Pool) {}

  public async request(tenantId: string, callerId: string, requestId: string) {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const existing = await client.query<TenantDeletionJobRow>(
        `SELECT * FROM tenant_deletion_jobs WHERE tenant_id = $1 LIMIT 1`,
        [tenantId],
      );
      if (existing.rows[0] !== undefined) {
        await client.query("COMMIT");
        transactionOpen = false;
        return { created: false, row: existing.rows[0] };
      }

      const tenant = await client.query<{ do_not_delete: boolean }>(
        `SELECT do_not_delete FROM tenants WHERE id = $1 FOR SHARE`,
        [tenantId],
      );
      if (tenant.rows[0] === undefined) {
        throw brainError("tenant_not_found", "tenant not found");
      }
      if (PROTECTED_TENANT_IDS.has(tenantId) || tenant.rows[0].do_not_delete) {
        await enqueueAuditOutbox(client, {
          tenantId,
          action: "tenant.delete_rejected",
          payload: { reason: "protected_tenant" },
          eventKey: `${requestId}:tenant.delete_rejected`,
          actor: callerId,
          inputs: { tenant_id: tenantId },
        });
        await client.query("COMMIT");
        transactionOpen = false;
        throw brainError("tenant_access_denied", "protected tenant cannot be deleted", {
          details: { reason: "protected_tenant" },
        });
      }

      const id = newTenantDeletionJobId();
      const inserted = await client.query<TenantDeletionJobRow>(
        `INSERT INTO tenant_deletion_jobs (id, tenant_id, requested_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
         RETURNING *`,
        [id, tenantId, callerId],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("tenant deletion job insert returned no row");
      await enqueueAuditOutbox(client, {
        jobId: row.id,
        tenantId,
        action: "tenant.delete_requested",
        payload: { job_id: row.id },
        eventKey: `${row.id}:tenant.delete_requested`,
        actor: callerId,
        inputs: { tenant_id: tenantId, requested_by: callerId },
      });
      await client.query("COMMIT");
      transactionOpen = false;
      return { created: row.id === id, row };
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original error.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async find(jobId: string): Promise<TenantDeletionJobRow | null> {
    const result = await this.pool.query<TenantDeletionJobRow>(
      `SELECT * FROM tenant_deletion_jobs WHERE id = $1 LIMIT 1`,
      [jobId],
    );
    return result.rows[0] ?? null;
  }
}

export async function claimTenantDeletionJob(
  client: PoolClient,
  workerId: string,
): Promise<TenantDeletionJobRow | null> {
  const result = await client.query<TenantDeletionJobRow>(
    `WITH candidate AS (
       SELECT id FROM tenant_deletion_jobs
        WHERE status = 'queued'
           OR (
             status IN ('fencing', 'deleting')
             AND locked_at < now() - interval '15 minutes'
           )
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE tenant_deletion_jobs job
        SET status = 'fencing', locked_at = now(), locked_by = $1,
            started_at = COALESCE(started_at, now()), updated_at = now()
       FROM candidate
      WHERE job.id = candidate.id
     RETURNING job.*`,
    [workerId],
  );
  return result.rows[0] ?? null;
}
