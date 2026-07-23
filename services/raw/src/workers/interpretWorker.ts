/**
 * Interpretation worker (Appendix B mechanism 2) — peer of the sync worker.
 *
 * Picks up landed artifacts whose declared source_schema has a registered
 * interpreter, runs the pure interpreter over the retained bytes, and writes
 * the produced raw_parsed row (idempotent on (artifact, parser, version)).
 * The Ledger's normalize worker then promotes the parsed rows to entities,
 * so the full structured-pull pipeline is:
 *
 *   syncWorker (provider -> raw_artifacts)
 *     -> interpretWorker (raw_artifacts -> raw_parsed)        [this worker]
 *       -> normalizeWorker (raw_parsed -> Ledger entities)
 *
 * Outcomes (including interpreter errors and empty pages) are recorded in
 * raw_interpretation_log so cycles are idempotent; failures never block
 * unrelated artifacts (quarantine-by-row, §11 "Validated"). A failed
 * artifact (error IS NOT NULL) is retried with bounded exponential backoff
 * up to a maximum attempt count, then becomes terminal-failed; a row with
 * error IS NULL (including the "interpreter yielded nothing" case) is
 * terminal-success and is never re-polled.
 *
 * The artifact poll is cross-tenant (BYPASSRLS/superuser in production, same
 * controlled exception as the sync and normalize workers); each artifact's
 * writes run tenant-scoped.
 */

import type { Pool } from "pg";
import {
  newRawParsedId,
  sha256Hex,
  startManagedInterval,
  withTenantScope,
  type AuditEmitter,
  type BlobAdapter,
  type ManagedWorker,
  type MetricsEmitter,
} from "@brain/shared";
import { interpreterForSchema, registeredSchemas } from "../interpreters/registry.js";
import { insertParsed } from "../repository/parsed.js";

// Bounded-retry constants mirror services/api/src/raw-extract/worker.ts
// exactly (one retry shape across both raw-layer async workers).
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 30_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;

export interface InterpretWorkerDeps {
  pool: Pool;
  blob: BlobAdapter;
  audit: AuditEmitter;
  metrics?: MetricsEmitter;
}

export interface InterpretWorkerOptions {
  /** Polling interval in milliseconds. Default: 15 000 (15 s). */
  intervalMs?: number;
  /** Maximum artifacts per poll cycle. Default: 20. */
  batchSize?: number;
  /** Actor id attributed to interpretation audit events. */
  actor?: string;
  /** Attempts before a failing artifact is terminal-failed. Default: 3. */
  maxAttempts?: number;
  /** Base backoff delay in milliseconds. Default: 30 000 (30 s). */
  retryBaseMs?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export type InterpretWorker = ManagedWorker;

interface PendingArtifactRow {
  id: string;
  tenant_id: string;
  source_type: string;
  source_schema: string;
  source_ref: Record<string, unknown>;
  source_id: string | null;
  object_type: string | null;
  mime_type: string | null;
  blob_uri: string;
  /** Attempts already recorded for this artifact (0 if never logged). */
  attempt_count: number;
}

/** Bounded exponential backoff, capped at MAX_RETRY_DELAY_MS. */
function nextRetryAt(now: Date, retryBaseMs: number, attemptCount: number): Date {
  const delay = Math.min(retryBaseMs * 2 ** Math.max(0, attemptCount - 1), MAX_RETRY_DELAY_MS);
  return new Date(now.getTime() + delay);
}

async function bufferStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function recordInterpretation(
  pool: Pool,
  row: PendingArtifactRow,
  parsedId: string | null,
  errorMessage: string | null,
  attemptCount: number,
  nextAttemptAt: Date | null,
): Promise<void> {
  await withTenantScope(pool, row.tenant_id, async (c) => {
    await c.query(
      `INSERT INTO raw_interpretation_log
         (raw_artifact_id, tenant_id, source_schema, parsed_id, error, attempt_count, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (raw_artifact_id) DO UPDATE SET
         parsed_id = EXCLUDED.parsed_id,
         error = EXCLUDED.error,
         attempt_count = EXCLUDED.attempt_count,
         next_attempt_at = EXCLUDED.next_attempt_at,
         interpreted_at = now()`,
      [
        row.id,
        row.tenant_id,
        row.source_schema,
        parsedId,
        errorMessage,
        attemptCount,
        nextAttemptAt,
      ],
    );
  });
}

/** One full interpretation cycle. Exported for tests; startInterpretWorker schedules it. */
export async function runInterpretCycle(
  deps: InterpretWorkerDeps,
  opts?: InterpretWorkerOptions,
): Promise<void> {
  const batchSize = opts?.batchSize ?? 20;
  const actor = opts?.actor ?? "sys_interpret_worker";
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryBaseMs = opts?.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const now = opts?.now ?? (() => new Date());

  let rows: PendingArtifactRow[];
  try {
    // Cross-tenant poll — requires BYPASSRLS or superuser in production.
    // An artifact is picked up when it has no log row yet, OR its log row
    // recorded an error, has not exhausted maxAttempts, and its backoff has
    // elapsed. A log row with error IS NULL is terminal-success and is never
    // matched by either branch.
    const result = await deps.pool.query<PendingArtifactRow>(
      `SELECT ra.id, ra.tenant_id, ra.source_type, ra.source_schema, ra.source_ref,
              ra.source_id, ra.object_type, ra.mime_type, ra.blob_uri,
              COALESCE(il.attempt_count, 0) AS attempt_count
         FROM raw_artifacts ra
         LEFT JOIN raw_interpretation_log il ON il.raw_artifact_id = ra.id
        WHERE ra.source_schema = ANY($2::text[])
          AND ra.tombstoned_at IS NULL
          AND (
            il.raw_artifact_id IS NULL
            OR (
              il.error IS NOT NULL
              AND il.attempt_count < $3
              AND (il.next_attempt_at IS NULL OR il.next_attempt_at <= now())
            )
          )
        ORDER BY ra.ingested_at ASC
        LIMIT $1`,
      [batchSize, registeredSchemas(), maxAttempts],
    );
    rows = result.rows;
  } catch (err) {
    console.error("[interpretWorker] poll query failed:", err);
    return;
  }

  for (const row of rows) {
    const interpreter = interpreterForSchema(row.source_schema);
    if (interpreter === undefined) continue; // registry changed mid-cycle

    try {
      const bytes = await bufferStream(await deps.blob.get(row.blob_uri));
      const output = interpreter(bytes, {
        rawArtifactId: row.id,
        tenantId: row.tenant_id,
        sourceType: row.source_type,
        sourceSchema: row.source_schema,
        sourceRef: row.source_ref,
        sourceId: row.source_id,
        objectType: row.object_type,
        mimeType: row.mime_type,
      });

      if (output === null) {
        // Intentionally nothing to promote (e.g. empty delta page). Terminal
        // success -- error stays NULL so this artifact is never re-polled.
        await recordInterpretation(deps.pool, row, null, null, row.attempt_count, null);
        continue;
      }

      const { parsed, created } = await withTenantScope(deps.pool, row.tenant_id, async (c) => {
        const result = await insertParsed(c, {
          id: newRawParsedId(),
          rawArtifactId: row.id,
          tenantId: row.tenant_id,
          parser: output.parser,
          parserVersion: output.parserVersion,
          extracted: output.extracted,
          confidence: output.confidence,
        });
        return { parsed: result.row, created: result.created };
      });
      // Terminal success -- clears any prior error and stops future retries.
      await recordInterpretation(deps.pool, row, parsed.id, null, row.attempt_count, null);

      // Mirrors the POST /raw/{id}/parsed audit shape — identifiers and a
      // content hash only (§6.1: extracted may carry PII).
      await deps.audit.emit({
        tenantId: row.tenant_id,
        layer: "raw",
        actor,
        action: created ? "raw.parsed.write" : "raw.parsed.deduplicated",
        inputs: {
          raw_id: row.id,
          parser: output.parser,
          parser_version: output.parserVersion,
          source_schema: row.source_schema,
          extracted_sha256: sha256Hex(Buffer.from(JSON.stringify(output.extracted))),
        },
        outputs: { parsed_id: parsed.id, created },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[interpretWorker] interpretation failed for ${row.id}:`, message);
      const attemptCount = row.attempt_count + 1;
      const stranded = attemptCount >= maxAttempts;
      const nextAttemptAt = stranded ? null : nextRetryAt(now(), retryBaseMs, attemptCount);
      try {
        await recordInterpretation(deps.pool, row, null, message, attemptCount, nextAttemptAt);
      } catch (logErr) {
        console.error(`[interpretWorker] failed to log interpretation for ${row.id}:`, logErr);
      }
      const tags = { source_schema: row.source_schema };
      if (stranded) {
        deps.metrics?.increment("brain.raw.interpretation.stranded.count", tags);
      } else {
        deps.metrics?.increment("brain.raw.interpretation.retry.count", tags);
      }
    }
  }
}

export function startInterpretWorker(
  deps: InterpretWorkerDeps,
  opts?: InterpretWorkerOptions,
): InterpretWorker {
  const intervalMs = opts?.intervalMs ?? 15_000;
  return startManagedInterval(() => runInterpretCycle(deps, opts), intervalMs, {
    name: "interpret",
    runImmediately: true,
    onError: (err) => console.error("[interpretWorker] cycle failed:", err),
  });
}
