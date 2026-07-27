import type { Pool } from "pg";
import {
  brainError,
  isBrainError,
  newRawParsedId,
  sha256Hex,
  startManagedInterval,
  withTenantScope,
  type BlobAdapter,
  type AuditEmitter,
  type ManagedWorker,
  type MetricsEmitter,
  type ServiceCallContext,
} from "@brain/shared";
import {
  claimExtractionJob,
  findArtifactById,
  insertParsed,
  interpreterForSchema,
  markExtractionJobFailed,
  markExtractionJobSucceeded,
  requeueExtractionJob,
  registeredSchemas,
  UPLOAD_DOCUMENT_SCHEMA,
  type InterpretedOutput,
  type RawArtifactRow,
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
const BANK_STATEMENT_UPLOAD_PARSER = "bank_statement_upload_v1";
const DOCUMENT_RECORDS_UPLOAD_PARSER = "document_records_upload_v1";
const CSV_MIME_TYPES = new Set([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export interface DocumentExtractionWorkerDeps {
  scanPool: Pool;
  appPool: Pool;
  blob: BlobAdapter;
  audit?: AuditEmitter;
  client?: DocumentExtractPort;
  metrics?: MetricsEmitter;
  log?: {
    error(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    info?(obj: unknown, msg?: string): void;
  };
}

export interface DocumentExtractionWorkerOptions {
  intervalMs?: number;
  batchSize?: number;
  jobId?: string;
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

interface RawParsedLookupRow {
  id: string;
  raw_artifact_id: string;
  tenant_id: string;
  parser: string;
  parser_version: string;
  extracted: Record<string, unknown>;
  confidence: number | null;
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
  const values: unknown[] = [batchSize];
  const jobFilter =
    opts.jobId === undefined
      ? ""
      : (() => {
          values.push(opts.jobId);
          return `AND id = $${values.length}`;
        })();
  const pending = await deps.scanPool.query<PendingExtractionJobRow>(
    `SELECT id, tenant_id, raw_id
       FROM extraction_jobs
      WHERE status = 'queued'
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ${jobFilter}
      ORDER BY created_at ASC
      LIMIT $1`,
    values,
  );

  for (const row of pending.rows) {
    const claimed = await withTenantScope(deps.appPool, row.tenant_id, (c) =>
      claimExtractionJob(c, row.id, workerId),
    );
    if (claimed === null) continue;
    await emitExtractionStatusChanged(deps, row.tenant_id, workerId, {
      jobId: row.id,
      rawId: row.raw_id,
      before: "queued",
      after: "running",
    });

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
        await emitExtractionStatusChanged(deps, row.tenant_id, workerId, {
          jobId: row.id,
          rawId: row.raw_id,
          before: "running",
          after: "failed",
          errorCode: artifact === null ? "raw_artifact_not_found" : "raw_artifact_tombstoned",
        });
        continue;
      }

      const bytes = await readAll(await deps.blob.get(artifact.blob_uri));
      const localParsed = await tryInProcessUploadExtraction(deps, {
        tenantId: row.tenant_id,
        actor: workerId,
        artifact,
        bytes,
      });
      if (localParsed !== null) {
        await withTenantScope(deps.appPool, row.tenant_id, (c) =>
          markExtractionJobSucceeded(c, row.id, {
            parsedId: localParsed.parsedId,
            confidence: localParsed.confidence,
          }),
        );
        deps.metrics?.increment("brain.raw.extraction_job.succeeded.count", {
          interpreter: "in_process",
        });
        await emitExtractionStatusChanged(deps, row.tenant_id, workerId, {
          jobId: row.id,
          rawId: row.raw_id,
          before: "running",
          after: "succeeded",
          parsedId: localParsed.parsedId,
          confidence: localParsed.confidence,
        });
        continue;
      }
      if (looksLikeUploadArtifact(artifact)) {
        deps.log?.warn(
          {
            raw_id: artifact.id,
            source_type: artifact.source_type,
            source_schema: artifact.source_schema,
            mime_type: artifact.mime_type,
            filename: sourceRefFilename(artifact.source_ref),
            git_sha: process.env["GIT_SHA"] ?? "dev",
          },
          "upload-like artifact fell through to external document extractor",
        );
      }

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
        await emitExtractionStatusChanged(deps, row.tenant_id, workerId, {
          jobId: row.id,
          rawId: row.raw_id,
          before: "running",
          after: "failed",
          errorCode: "dependency_unavailable",
        });
        continue;
      }

      const result = await deps.client.extract(ctxFor(row.tenant_id, workerId), {
        rawId: artifact.id,
        mimeType: artifact.mime_type ?? DEFAULT_MIME_TYPE,
        documentB64: bytes.toString("base64"),
        agentId,
      });
      const parsedId = await reconcileReturnedParsedParser(deps, {
        tenantId: row.tenant_id,
        rawId: artifact.id,
        parsedId: result.parsed_id,
        parser: result.parser,
        confidence: result.confidence,
        actor: workerId,
      });
      await withTenantScope(deps.appPool, row.tenant_id, (c) =>
        markExtractionJobSucceeded(c, row.id, {
          parsedId,
          confidence: Math.min(result.confidence, 0.5),
        }),
      );
      deps.metrics?.increment("brain.raw.extraction_job.succeeded.count");
      await emitExtractionStatusChanged(deps, row.tenant_id, workerId, {
        jobId: row.id,
        rawId: row.raw_id,
        before: "running",
        after: "succeeded",
        parsedId,
        confidence: Math.min(result.confidence, 0.5),
      });
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
        await emitExtractionStatusChanged(deps, row.tenant_id, workerId, {
          jobId: row.id,
          rawId: row.raw_id,
          before: "running",
          after: "queued",
          errorCode: reason,
        });
      } else {
        await withTenantScope(deps.appPool, row.tenant_id, (c) =>
          markExtractionJobFailed(c, row.id, {
            ...details,
            ...(isTransientExtractionError(err) ? { retry_exhausted: true } : {}),
          }),
        );
        deps.metrics?.increment("brain.raw.extraction_job.failed.count", { reason });
        await emitExtractionStatusChanged(deps, row.tenant_id, workerId, {
          jobId: row.id,
          rawId: row.raw_id,
          before: "running",
          after: "failed",
          errorCode: reason,
        });
      }
    }
  }
}

export function startDocumentExtractionWorker(
  deps: DocumentExtractionWorkerDeps,
  opts: DocumentExtractionWorkerOptions = {},
): ManagedWorker {
  deps.log?.info?.(
    {
      git_sha: process.env["GIT_SHA"] ?? "dev",
      upload_schema_registered: registeredSchemas().includes(UPLOAD_DOCUMENT_SCHEMA),
      brain_workers: process.env["BRAIN_WORKERS"] ?? "all",
    },
    "document extraction worker configured",
  );
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

async function tryInProcessUploadExtraction(
  deps: DocumentExtractionWorkerDeps,
  input: {
    tenantId: string;
    actor: string;
    artifact: RawArtifactRow;
    bytes: Buffer;
  },
): Promise<{ parsedId: string; confidence: number } | null> {
  const local = inProcessUploadInterpreter(input.artifact);
  if (local === undefined) return null;

  let output: InterpretedOutput | null;
  try {
    output = local.interpreter(input.bytes, {
      rawArtifactId: input.artifact.id,
      tenantId: input.tenantId,
      sourceType: local.sourceType,
      sourceSchema: input.artifact.source_schema ?? UPLOAD_DOCUMENT_SCHEMA,
      sourceRef: input.artifact.source_ref,
      sourceId: input.artifact.source_id,
      objectType: input.artifact.object_type,
      mimeType: input.artifact.mime_type,
    });
  } catch (err) {
    if (isBrainError(err) && err.code === "raw_source_unsupported") return null;
    throw err;
  }
  if (output === null) return null;

  const parsed = await insertInProcessParsed(deps, input, output);
  return {
    parsedId: parsed.id,
    confidence: output.confidence ?? 1,
  };
}

function inProcessUploadInterpreter(artifact: RawArtifactRow) {
  if (!registeredSchemas().includes(UPLOAD_DOCUMENT_SCHEMA)) return undefined;
  const sourceType = supportedUploadSourceType(artifact);
  if (sourceType === null) return undefined;
  const interpreter = interpreterForSchema(UPLOAD_DOCUMENT_SCHEMA);
  if (interpreter === undefined) return undefined;
  return { interpreter, sourceType };
}

function supportedUploadSourceType(artifact: RawArtifactRow): "pdf_upload" | "csv_upload" | null {
  const sourceType = artifact.source_type;
  const mimeType = normalizedMimeType(artifact.mime_type);
  const filename = sourceRefFilename(artifact.source_ref).toLowerCase();

  if (
    sourceType === "pdf_upload" ||
    mimeType === "application/pdf" ||
    ((mimeType === "" || mimeType === DEFAULT_MIME_TYPE) && filename.endsWith(".pdf"))
  ) {
    if (mimeType === "" || mimeType === "application/pdf" || mimeType === DEFAULT_MIME_TYPE) {
      return "pdf_upload";
    }
  }

  if (
    sourceType === "csv_upload" ||
    CSV_MIME_TYPES.has(mimeType) ||
    spreadsheetFilename(filename)
  ) {
    if (mimeType === "" || mimeType === DEFAULT_MIME_TYPE || CSV_MIME_TYPES.has(mimeType)) {
      return "csv_upload";
    }
  }

  return null;
}

function looksLikeUploadArtifact(artifact: RawArtifactRow): boolean {
  return supportedUploadSourceType(artifact) !== null;
}

function normalizedMimeType(mimeType: string | null): string {
  return (mimeType ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function spreadsheetFilename(filename: string): boolean {
  return filename.endsWith(".csv") || filename.endsWith(".xlsx") || filename.endsWith(".xls");
}

function sourceRefFilename(sourceRef: Record<string, unknown>): string {
  const filename =
    sourceRef["filename"] ??
    sourceRef["file_name"] ??
    sourceRef["name"] ??
    sourceRef["original_filename"];
  return typeof filename === "string" ? filename : "";
}

function assertExternalParserPayloadMatches(
  parser: string,
  extracted: Record<string, unknown>,
): void {
  const objectType = extracted["object_type"];
  const matches =
    parser === BANK_STATEMENT_UPLOAD_PARSER
      ? objectType === "bank_statement"
      : parser === DOCUMENT_RECORDS_UPLOAD_PARSER
        ? objectType === "ar_aging" || objectType === "payroll_register"
        : true;
  if (matches) return;
  throw brainError(
    "raw_source_unsupported",
    `document extraction agent returned ${String(objectType ?? "unknown")} for ${parser}`,
    { statusOverride: 422 },
  );
}

function isUploadParser(parser: string): boolean {
  return parser === BANK_STATEMENT_UPLOAD_PARSER || parser === DOCUMENT_RECORDS_UPLOAD_PARSER;
}

async function insertInProcessParsed(
  deps: DocumentExtractionWorkerDeps,
  input: {
    tenantId: string;
    actor: string;
    artifact: RawArtifactRow;
  },
  output: InterpretedOutput,
): Promise<{ id: string }> {
  const { parsed, created } = await withTenantScope(deps.appPool, input.tenantId, async (c) => {
    const result = await insertParsed(c, {
      id: newRawParsedId(),
      rawArtifactId: input.artifact.id,
      tenantId: input.tenantId,
      parser: output.parser,
      parserVersion: output.parserVersion,
      extracted: output.extracted,
      confidence: output.confidence,
      // Trusted: this worker re-derives `extracted` deterministically from
      // the immutable raw bytes, not from caller-supplied content. See
      // InsertParsedInput.allowRepair.
      allowRepair: true,
    });
    return { parsed: result.row, created: result.created };
  });

  await deps.audit?.emit({
    tenantId: input.tenantId,
    layer: "raw",
    actor: input.actor,
    action: created ? "raw.parsed.write" : "raw.parsed.deduplicated",
    inputs: {
      raw_id: input.artifact.id,
      parser: output.parser,
      parser_version: output.parserVersion,
      source_schema: input.artifact.source_schema ?? UPLOAD_DOCUMENT_SCHEMA,
      extracted_sha256: sha256Hex(Buffer.from(JSON.stringify(output.extracted))),
    },
    outputs: { parsed_id: parsed.id, created },
  });

  return { id: parsed.id };
}

async function reconcileReturnedParsedParser(
  deps: DocumentExtractionWorkerDeps,
  input: {
    tenantId: string;
    rawId: string;
    parsedId: string;
    parser: string;
    confidence: number;
    actor: string;
  },
): Promise<string> {
  if (input.parser.length === 0) {
    deps.log?.warn(
      { raw_id: input.rawId, parsed_id: input.parsedId },
      "document extraction agent returned no parser",
    );
    return input.parsedId;
  }

  return withTenantScope(deps.appPool, input.tenantId, async (c) => {
    const existing = await c.query<RawParsedLookupRow>(
      `SELECT id, raw_artifact_id, tenant_id, parser, parser_version, extracted, confidence
         FROM raw_parsed
        WHERE id = $1 AND raw_artifact_id = $2
        LIMIT 1`,
      [input.parsedId, input.rawId],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      deps.log?.warn(
        { raw_id: input.rawId, parsed_id: input.parsedId, parser: input.parser },
        "document extraction agent returned a parsed id with no matching raw_parsed row",
      );
      return input.parsedId;
    }
    if (isUploadParser(input.parser)) {
      assertExternalParserPayloadMatches(input.parser, row.extracted);
    }
    if (row.parser === input.parser) return row.id;

    const fixedId = newRawParsedId();
    const inserted = await c.query<Pick<RawParsedLookupRow, "id">>(
      `INSERT INTO raw_parsed
         (id, raw_artifact_id, tenant_id, parser, parser_version, extracted, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (raw_artifact_id, parser, parser_version) DO NOTHING
       RETURNING id`,
      [
        fixedId,
        input.rawId,
        input.tenantId,
        input.parser,
        row.parser_version,
        JSON.stringify(row.extracted),
        Math.min(row.confidence ?? input.confidence, 0.5),
      ],
    );
    const parsedId = inserted.rows[0]?.id;
    if (parsedId !== undefined) {
      await deps.audit?.emit({
        tenantId: input.tenantId,
        layer: "raw",
        actor: input.actor,
        action: "raw.parsed.write",
        inputs: {
          raw_id: input.rawId,
          parser: input.parser,
          parser_version: row.parser_version,
          source_parser: row.parser,
          extracted_sha256: sha256Hex(Buffer.from(JSON.stringify(row.extracted))),
        },
        outputs: { parsed_id: parsedId, created: true },
      });
      return parsedId;
    }

    const corrected = await c.query<Pick<RawParsedLookupRow, "id">>(
      `SELECT id
         FROM raw_parsed
        WHERE raw_artifact_id = $1 AND parser = $2 AND parser_version = $3
        LIMIT 1`,
      [input.rawId, input.parser, row.parser_version],
    );
    return corrected.rows[0]?.id ?? input.parsedId;
  });
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

async function emitExtractionStatusChanged(
  deps: DocumentExtractionWorkerDeps,
  tenantId: string,
  actor: string,
  input: {
    jobId: string;
    rawId: string;
    before: string;
    after: string;
    parsedId?: string;
    confidence?: number;
    errorCode?: string;
  },
): Promise<void> {
  if (deps.audit === undefined) return;
  await deps.audit.emit({
    tenantId,
    layer: "raw",
    actor,
    action: "raw.extraction.status_changed",
    inputs: { job_id: input.jobId, raw_id: input.rawId },
    outputs: {
      before: { status: input.before },
      after: {
        status: input.after,
        ...(input.parsedId !== undefined ? { parsed_id: input.parsedId } : {}),
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        ...(input.errorCode !== undefined ? { error_code: input.errorCode } : {}),
      },
    },
  });
}
