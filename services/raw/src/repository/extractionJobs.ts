import { newRawExtractionJobId, type TenantScopedClient } from "@brain/shared";

export type ExtractionJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface ExtractionJobRow {
  id: string;
  tenant_id: string;
  raw_id: string;
  content_sha256: Buffer;
  status: ExtractionJobStatus;
  parsed_id: string | null;
  confidence: number | null;
  error: Record<string, unknown> | null;
  attempt_count: number;
  next_attempt_at: Date | null;
  requested_by: string | null;
  locked_at: Date | null;
  locked_by: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ExtractionJobWire {
  job_id: string;
  raw_id: string;
  status: ExtractionJobStatus;
  parsed_id: string | null;
  confidence: number | null;
  error: Record<string, unknown> | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueExtractionJobInput {
  tenantId: string;
  rawId: string;
  contentSha256: Buffer;
  requestedBy: string;
}

export async function isAutoExtractDocumentsEnabled(client: TenantScopedClient): Promise<boolean> {
  const { rows } = await client.query<{ auto_extract_documents: boolean }>(
    `SELECT auto_extract_documents
       FROM raw_tenant_settings
      WHERE tenant_id = current_setting('app.tenant_id', true)
      LIMIT 1`,
  );
  return rows[0]?.auto_extract_documents === true;
}

export async function enqueueExtractionJob(
  client: TenantScopedClient,
  input: EnqueueExtractionJobInput,
): Promise<{ row: ExtractionJobRow; created: boolean }> {
  const id = newRawExtractionJobId();
  const { rows } = await client.query<ExtractionJobRow>(
    `INSERT INTO extraction_jobs
       (id, tenant_id, raw_id, content_sha256, status, requested_by)
     VALUES ($1, $2, $3, $4, 'queued', $5)
     ON CONFLICT (tenant_id, raw_id, content_sha256) DO UPDATE SET
       status = CASE
         WHEN extraction_jobs.status = 'succeeded' THEN extraction_jobs.status
         WHEN extraction_jobs.status = 'running' THEN extraction_jobs.status
         ELSE 'queued'
       END,
       error = CASE
         WHEN extraction_jobs.status = 'succeeded' THEN extraction_jobs.error
         WHEN extraction_jobs.status = 'running' THEN extraction_jobs.error
         ELSE NULL
       END,
       attempt_count = CASE
         WHEN extraction_jobs.status IN ('succeeded', 'running') THEN extraction_jobs.attempt_count
         ELSE 0
       END,
       next_attempt_at = CASE
         WHEN extraction_jobs.status IN ('succeeded', 'running') THEN extraction_jobs.next_attempt_at
         ELSE NULL
       END,
       finished_at = CASE
         WHEN extraction_jobs.status IN ('succeeded', 'running') THEN extraction_jobs.finished_at
         ELSE NULL
       END,
       started_at = CASE
         WHEN extraction_jobs.status IN ('succeeded', 'running') THEN extraction_jobs.started_at
         ELSE NULL
       END,
       locked_at = CASE
         WHEN extraction_jobs.status = 'running' THEN extraction_jobs.locked_at
         ELSE NULL
       END,
       locked_by = CASE
         WHEN extraction_jobs.status = 'running' THEN extraction_jobs.locked_by
         ELSE NULL
       END,
       requested_by = EXCLUDED.requested_by,
       updated_at = now()
     RETURNING *`,
    [id, input.tenantId, input.rawId, input.contentSha256, input.requestedBy],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("extraction_jobs enqueue returned no row");
  return { row, created: row.id === id };
}

export async function findLatestExtractionJob(
  client: TenantScopedClient,
  rawId: string,
): Promise<ExtractionJobRow | null> {
  const { rows } = await client.query<ExtractionJobRow>(
    `SELECT *
       FROM extraction_jobs
      WHERE raw_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [rawId],
  );
  return rows[0] ?? null;
}

export async function claimExtractionJob(
  client: TenantScopedClient,
  jobId: string,
  workerId: string,
): Promise<ExtractionJobRow | null> {
  const { rows } = await client.query<ExtractionJobRow>(
    `UPDATE extraction_jobs
        SET status = 'running',
            attempt_count = attempt_count + 1,
            locked_at = now(),
            locked_by = $2,
            started_at = COALESCE(started_at, now()),
            updated_at = now()
      WHERE id = $1
        AND status = 'queued'
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      RETURNING *`,
    [jobId, workerId],
  );
  return rows[0] ?? null;
}

export async function markExtractionJobSucceeded(
  client: TenantScopedClient,
  jobId: string,
  result: { parsedId: string; confidence: number },
): Promise<void> {
  await client.query(
    `UPDATE extraction_jobs
        SET status = 'succeeded',
            parsed_id = $2,
            confidence = $3,
            error = NULL,
            next_attempt_at = NULL,
            finished_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [jobId, result.parsedId, result.confidence],
  );
}

export async function requeueExtractionJob(
  client: TenantScopedClient,
  jobId: string,
  error: Record<string, unknown>,
  nextAttemptAt: Date,
): Promise<void> {
  await client.query(
    `UPDATE extraction_jobs
        SET status = 'queued',
            error = $2,
            next_attempt_at = $3,
            locked_at = NULL,
            locked_by = NULL,
            updated_at = now()
      WHERE id = $1`,
    [jobId, JSON.stringify(error), nextAttemptAt],
  );
}

export async function markExtractionJobFailed(
  client: TenantScopedClient,
  jobId: string,
  error: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `UPDATE extraction_jobs
        SET status = 'failed',
            error = $2,
            next_attempt_at = NULL,
            locked_at = NULL,
            locked_by = NULL,
            finished_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [jobId, JSON.stringify(error)],
  );
}

export function extractionJobToWire(row: ExtractionJobRow): ExtractionJobWire {
  return {
    job_id: row.id,
    raw_id: row.raw_id,
    status: row.status,
    parsed_id: row.parsed_id,
    confidence: row.confidence,
    error: row.error,
    next_attempt_at: toIsoOptional(row.next_attempt_at),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function toIso(d: Date | string): string {
  return typeof d === "string" ? d : d.toISOString();
}

function toIsoOptional(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  return toIso(d);
}
