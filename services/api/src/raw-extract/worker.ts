import type { Pool } from "pg";
import {
  isBrainError,
  startManagedInterval,
  withTenantScope,
  type BlobAdapter,
  type ManagedWorker,
  type MetricsEmitter,
  type ServiceCallContext,
} from "@brain/shared";
import {
  claimExtractionJob,
  findArtifactById,
  markExtractionJobFailed,
  markExtractionJobSucceeded,
  requeueExtractionJob,
} from "@brain/raw";
import type {
  DocumentExtractInput,
  DocumentExtractResult,
} from "../agents/documentExtractClient.js";

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 30_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;
const DEFAULT_MIME_TYPE = "application/octet-stream";
const WORKER_ACTOR = "document_extraction_worker";

export interface DocumentExtractionWorkerDeps {
  scanPool: Pool;
  appPool: Pool;
  blob: BlobAdapter;
  client?: DocumentExtractPort;
  metrics?: MetricsEmitter;
  log?: {
    error(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
}

export interface DocumentExtractionWorkerOptions {
  intervalMs?: number;
  batchSize?: number;
  workerId?: string;
  agentId?: string;
  maxAttempts?: number;
  retryBaseMs?: number;
  now?: () => Date;
}

interface PendingExtractionJobRow {
  id: string;
  tenant_id: string;
  raw_id: string;
}

export interface DocumentExtractPort {
  extract(ctx: ServiceCallContext, input: DocumentExtractInput): Promise<DocumentExtractResult>;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array));
  }
  return Buffer.concat(chunks);
}

export async function runDocumentExtractionCycle(
  deps: DocumentExtractionWorkerDeps,
  opts: DocumentExtractionWorkerOptions = {},
): Promise<void> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const workerId = opts.workerId ?? WORKER_ACTOR;
  const agentId = opts.agentId ?? "document_extractor";
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const now = opts.now ?? (() => new Date());
  const pending = await deps.scanPool.query<PendingExtractionJobRow>(
    `SELECT id, tenant_id, raw_id
       FROM extraction_jobs
      WHERE status = 'queued'
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY created_at ASC
      LIMIT $1`,
    [batchSize],
  );

  for (const row of pending.rows) {
    const claimed = await withTenantScope(deps.appPool, row.tenant_id, (c) =>
      claimExtractionJob(c, row.id, workerId),
    );
    if (claimed === null) continue;

    if (deps.client === undefined) {
      await withTenantScope(deps.appPool, row.tenant_id, (c) =>
        markExtractionJobFailed(c, row.id, {
          code: "dependency_unavailable",
          message: "document extraction agent is not configured",
        }),
      );
      deps.metrics?.increment("brain.raw.extraction_job.failed.count", {
        reason: "dependency_unavailable",
      });
      continue;
    }

    try {
      const artifact = await withTenantScope(deps.appPool, row.tenant_id, (c) =>
        findArtifactById(c, row.raw_id),
      );
      if (artifact === null || artifact.tombstoned_at !== null) {
        await withTenantScope(deps.appPool, row.tenant_id, (c) =>
          markExtractionJobFailed(c, row.id, {
            code: artifact === null ? "raw_artifact_not_found" : "raw_artifact_tombstoned",
            message: artifact === null ? "raw artifact not found" : "raw artifact tombstoned",
          }),
        );
        deps.metrics?.increment("brain.raw.extraction_job.failed.count", {
          reason: artifact === null ? "raw_artifact_not_found" : "raw_artifact_tombstoned",
        });
        continue;
      }

      const bytes = await readAll(await deps.blob.get(artifact.blob_uri));
      const result = await deps.client.extract(ctxFor(row.tenant_id, workerId), {
        rawId: artifact.id,
        mimeType: artifact.mime_type ?? DEFAULT_MIME_TYPE,
        documentB64: bytes.toString("base64"),
        agentId,
      });
      await withTenantScope(deps.appPool, row.tenant_id, (c) =>
        markExtractionJobSucceeded(c, row.id, {
          parsedId: result.parsed_id,
          confidence: Math.min(result.confidence, 0.5),
        }),
      );
      deps.metrics?.increment("brain.raw.extraction_job.succeeded.count");
    } catch (err) {
      deps.log?.error(
        { err, job_id: row.id, raw_id: row.raw_id },
        "document extraction job failed",
      );
      const details = errorToDetails(err);
      const reason = String(details["code"] ?? "internal_server_error");
      if (isTransientExtractionError(err) && claimed.attempt_count < maxAttempts) {
        const nextAttemptAt = nextRetryAt(now(), retryBaseMs, claimed.attempt_count);
        await withTenantScope(deps.appPool, row.tenant_id, (c) =>
          requeueExtractionJob(c, row.id, details, nextAttemptAt),
        );
        deps.metrics?.increment("brain.raw.extraction_job.retry.count", { reason });
      } else {
        await withTenantScope(deps.appPool, row.tenant_id, (c) =>
          markExtractionJobFailed(c, row.id, {
            ...details,
            ...(isTransientExtractionError(err) ? { retry_exhausted: true } : {}),
          }),
        );
        deps.metrics?.increment("brain.raw.extraction_job.failed.count", { reason });
      }
    }
  }
}

export function startDocumentExtractionWorker(
  deps: DocumentExtractionWorkerDeps,
  opts: DocumentExtractionWorkerOptions = {},
): ManagedWorker {
  return startManagedInterval(
    () => runDocumentExtractionCycle(deps, opts),
    opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    {
      name: "document-extraction",
      runImmediately: false,
      onError: (err) => deps.log?.error({ err }, "document extraction worker failed"),
    },
  );
}

function ctxFor(tenantId: string, actor: string): ServiceCallContext {
  return {
    tenantId,
    actor,
    principalType: "agent",
    scopes: ["raw:write"],
  };
}

function errorToDetails(err: unknown): Record<string, unknown> {
  if (isBrainError(err)) {
    return {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
  }
  return {
    code: "internal_server_error",
    message: err instanceof Error ? err.message : String(err),
  };
}

function nextRetryAt(now: Date, retryBaseMs: number, attemptCount: number): Date {
  const delay = Math.min(retryBaseMs * 2 ** Math.max(0, attemptCount - 1), MAX_RETRY_DELAY_MS);
  return new Date(now.getTime() + delay);
}

function isTransientExtractionError(err: unknown): boolean {
  if (!isBrainError(err)) return true;
  if (err.statusCode >= 500) return true;
  return false;
}
