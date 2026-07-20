import { newTenantExportJobId, type TenantScopedClient } from "@brain/shared";

export type TenantExportJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface TenantExportJobRow {
  id: string;
  tenant_id: string;
  status: TenantExportJobStatus;
  output_blob_uri: string | null;
  byte_size: string | number | null;
  expires_at: Date | string;
  error: Record<string, unknown> | null;
  requested_by: string;
  locked_at: Date | string | null;
  locked_by: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  purged_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface TenantExportJobWire {
  job_id: string;
  tenant_id: string;
  status: TenantExportJobStatus;
  byte_size: number | null;
  expires_at: string;
  error: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export async function enqueueTenantExportJob(
  client: TenantScopedClient,
  input: { tenantId: string; requestedBy: string; expiresAt: Date },
): Promise<{ row: TenantExportJobRow; created: boolean }> {
  const id = newTenantExportJobId();
  const { rows } = await client.query<TenantExportJobRow>(
    `INSERT INTO tenant_export_jobs (id, tenant_id, status, requested_by, expires_at)
     VALUES ($1, $2, 'queued', $3, $4)
     ON CONFLICT (tenant_id) WHERE status IN ('queued','running')
     DO UPDATE SET updated_at = tenant_export_jobs.updated_at
     RETURNING *`,
    [id, input.tenantId, input.requestedBy, input.expiresAt],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("tenant_export_jobs enqueue returned no row");
  return { row, created: row.id === id };
}

export async function findTenantExportJob(
  client: TenantScopedClient,
  jobId: string,
): Promise<TenantExportJobRow | null> {
  const { rows } = await client.query<TenantExportJobRow>(
    `SELECT * FROM tenant_export_jobs WHERE id = $1 LIMIT 1`,
    [jobId],
  );
  return rows[0] ?? null;
}

export async function claimTenantExportJob(
  client: TenantScopedClient,
  jobId: string,
  workerId: string,
): Promise<TenantExportJobRow | null> {
  const { rows } = await client.query<TenantExportJobRow>(
    `UPDATE tenant_export_jobs
        SET status = 'running',
            locked_at = now(),
            locked_by = $2,
            started_at = COALESCE(started_at, now()),
            updated_at = now()
      WHERE id = $1
        AND status = 'queued'
      RETURNING *`,
    [jobId, workerId],
  );
  return rows[0] ?? null;
}

export async function markTenantExportJobSucceeded(
  client: TenantScopedClient,
  jobId: string,
  result: { outputBlobUri: string; byteSize: number },
): Promise<void> {
  await client.query(
    `UPDATE tenant_export_jobs
        SET status = 'succeeded',
            output_blob_uri = $2,
            byte_size = $3,
            error = NULL,
            locked_at = NULL,
            locked_by = NULL,
            finished_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [jobId, result.outputBlobUri, result.byteSize],
  );
}

export async function markTenantExportJobFailed(
  client: TenantScopedClient,
  jobId: string,
  error: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `UPDATE tenant_export_jobs
        SET status = 'failed',
            output_blob_uri = NULL,
            byte_size = NULL,
            error = $2,
            locked_at = NULL,
            locked_by = NULL,
            finished_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [jobId, JSON.stringify(error)],
  );
}

export async function markTenantExportJobPurged(
  client: TenantScopedClient,
  jobId: string,
): Promise<void> {
  await client.query(
    `UPDATE tenant_export_jobs
        SET output_blob_uri = NULL,
            purged_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [jobId],
  );
}

export function tenantExportJobToWire(row: TenantExportJobRow): TenantExportJobWire {
  return {
    job_id: row.id,
    tenant_id: row.tenant_id,
    status: row.status,
    byte_size: row.byte_size === null ? null : Number(row.byte_size),
    expires_at: toIso(row.expires_at),
    error: row.error,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
