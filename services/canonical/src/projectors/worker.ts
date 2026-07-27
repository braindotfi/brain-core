/**
 * Canonical projection worker (ingestion architecture §12, Phase 5, PR-B).
 *
 * The canonical-layer analogue of the Ledger normalize worker: it reads
 * raw_parsed (the same sanctioned cross-pipeline read the normalize worker
 * performs) and projects rich domain records into the canonical store. The
 * full structured-pull pipeline becomes:
 *
 *   syncWorker (provider -> raw_artifacts)
 *     -> interpretWorker (raw_artifacts -> raw_parsed)
 *       -> normalizeWorker  (raw_parsed -> Ledger entities)   [compact truth]
 *       -> canonical projector (raw_parsed -> canonical)      [rich domain, this worker]
 *
 * Slice 1 projects Merge accounting gl_account and journal_entry pages. The
 * poll is cross-tenant (BYPASSRLS privileged pool, same controlled exception as
 * the sync/interpret/normalize workers); every write runs tenant-scoped inside
 * a single transaction with its projection-log row, so a crash rolls back both
 * and the row is reprocessed (idempotent upserts make replay a no-op).
 *
 * GL-account pages are ordered ahead of journal_entry pages so a line's GL
 * reference resolves to a canonical account id in the same cycle where possible;
 * unresolved references are filled on any later replay.
 */

import type { Pool } from "pg";
import {
  sha256Hex,
  startManagedInterval,
  leasedCycle,
  withTenantScope,
  type AuditEmitter,
  type ManagedWorker,
  type MetricsEmitter,
  type TenantScopedClient,
} from "@brain/shared";
import { upsertGlAccount, upsertJournalEntry } from "../repository/accounting.js";
import {
  MERGE_ACCOUNTING_PARSER,
  MERGE_ACCOUNTING_PROJECTOR,
  PROJECTABLE_OBJECT_TYPES,
  projectGlAccount,
  projectJournalEntry,
  type ProjectionCommon,
} from "./merge-accounting.js";
import { projectMergeContact, projectMergeInvoice } from "./merge-apar.js";
import { projectDocObligation } from "./doc-obligation.js";
import { upsertCanonicalCounterparty, upsertCanonicalObligation } from "../repository/apar.js";
import {
  BANK_STATEMENT_UPLOAD_PARSER,
  BANK_STATEMENT_UPLOAD_PROJECTOR,
  DOCUMENT_RECORDS_UPLOAD_PARSER,
  DOCUMENT_RECORDS_UPLOAD_PROJECTOR,
  FINCH_LEDGER_PARSER,
  FINCH_LEDGER_PROJECTOR,
  PLAID_LEDGER_PARSER,
  PLAID_LEDGER_PROJECTOR,
  STRIPE_LEDGER_PARSER,
  STRIPE_LEDGER_PROJECTOR,
  projectBankStatementUploadLedger,
  projectDocumentRecordsUploadLedger,
  projectFinchLedger,
  projectPlaidLedger,
  projectStripeLedger,
  type ConnectorLedgerProjection,
  type ConnectorProjectionDiagnostics,
} from "./connector-ledger.js";
import { upsertCanonicalAccount, upsertCanonicalTransaction } from "../repository/ledger.js";

/** RFC 0004 document-extracted obligations (low-trust, agent_contributed). */
const DOC_OBLIGATION_PARSER = "doc_obligation_v1" as const;
const DOC_OBLIGATION_PROJECTOR = "doc_obligation_canonical_v1" as const;
/** Provider-projected obligation/counterparty confidence, matching the old extractor. */
const MERGE_OBLIGATION_CONFIDENCE = 0.85;
const MERGE_COUNTERPARTY_CONFIDENCE = 0.8;
/** Fallback when a document's raw_parsed row carries no confidence (capped agent ceiling). */
const DOC_DEFAULT_CONFIDENCE = 0.5;

// parser identifies the raw_parsed producer. projector identifies this
// canonical projection pass and is the value stored in canonical_projection_log
// plus emitted to upload projection hooks.
const CONNECTOR_LEDGER_PASSES = [
  {
    parser: PLAID_LEDGER_PARSER,
    projector: PLAID_LEDGER_PROJECTOR,
    objectType: "plaid",
    project: projectPlaidLedger,
  },
  {
    parser: STRIPE_LEDGER_PARSER,
    projector: STRIPE_LEDGER_PROJECTOR,
    objectType: "stripe",
    project: projectStripeLedger,
  },
  {
    parser: FINCH_LEDGER_PARSER,
    projector: FINCH_LEDGER_PROJECTOR,
    objectType: "finch",
    project: projectFinchLedger,
  },
  {
    parser: BANK_STATEMENT_UPLOAD_PARSER,
    projector: BANK_STATEMENT_UPLOAD_PROJECTOR,
    objectType: "bank_statement_upload",
    project: projectBankStatementUploadLedger,
  },
  {
    parser: DOCUMENT_RECORDS_UPLOAD_PARSER,
    projector: DOCUMENT_RECORDS_UPLOAD_PROJECTOR,
    objectType: "document_records_upload",
    project: projectDocumentRecordsUploadLedger,
  },
] as const;

/**
 * Failed projections are retried up to this many times before they are
 * quarantined (moved aside). Keeps one poison record from wedging a tenant's
 * lane, while still surviving transient failures (deadlock / FK race / blip).
 */
const DEFAULT_MAX_PROJECTION_ATTEMPTS = 5;

/** A failed projection becomes quarantined once it has used its retry budget. */
export function isQuarantined(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}

function mergeConfidence(objectType: string | undefined): number | null {
  if (objectType === "invoice") return MERGE_OBLIGATION_CONFIDENCE;
  if (objectType === "contact") return MERGE_COUNTERPARTY_CONFIDENCE;
  return null; // gl_account / journal_entry are not obligations
}

export interface ProjectionWorkerDeps {
  pool: Pool;
  audit: AuditEmitter;
  onUploadProjected?: (event: LedgerUploadProjectedEvent) => Promise<void>;
  /** Optional: emits brain.canonical.projector.records.count so a stalled
   *  money-path projector (records flatlining while raw_parsed grows) is
   *  observable. No-op when absent. */
  metrics?: MetricsEmitter;
  log?: {
    debug(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
}

export interface LedgerUploadProjectionSummary {
  readonly accounts: number;
  readonly transactions: number;
  readonly receivables: number;
  readonly obligations: number;
  readonly newCounterparties: number;
}

export interface LedgerUploadProjectedEvent {
  readonly event: "ledger.upload.projected";
  readonly tenantId: string;
  readonly rawArtifactId: string;
  readonly rawParsedId: string;
  readonly projector: string;
  readonly summary: LedgerUploadProjectionSummary;
}

export interface ProjectionWorkerOptions {
  /** Polling interval in milliseconds. Default: 15 000 (15 s). */
  intervalMs?: number;
  /** Maximum raw_parsed rows per poll cycle. Default: 20. */
  batchSize?: number;
  /** Optional exact raw_parsed ids to drain ahead of the cross-tenant backlog. */
  rawParsedIds?: readonly string[];
  /** Actor id attributed to projection audit events. */
  actor?: string;
  /** Failed projections quarantined after this many attempts. Default: 5. */
  maxAttempts?: number;
}

export type ProjectionWorker = ManagedWorker;

interface PendingParsedRow {
  id: string;
  raw_artifact_id: string;
  tenant_id: string;
  extracted: { object_type?: string; merge_integration?: string | null };
  // Selected as ::text (not the driver's parsed Date) and round-tripped back
  // into parsed_extracted_at verbatim: a JS Date only holds millisecond
  // precision, but Postgres timestamptz (what `now()` stamps raw_parsed.
  // extracted_at with) carries microseconds, so a Date round-trip would
  // truncate and permanently fail PENDING_EXCLUSION's exact-version match.
  extracted_at: string;
}

// Object types this worker projects, across both canonical domains served by
// the merge_accounting_v1 parser. The SQL poll uses an explicit dependency
// order instead of lexical collation so reference pages are processed before
// pages that point at them.
const ALL_PROJECTABLE_OBJECT_TYPES: readonly string[] = [
  ...PROJECTABLE_OBJECT_TYPES,
  "invoice",
  "contact",
];

/** Projection-log domain label per object type. */
function domainFor(objectType: string | undefined): string {
  return objectType === "invoice" || objectType === "contact" ? "ap_ar" : "accounting";
}

function sourceSystemOf(mergeIntegration: string | null | undefined): string {
  return typeof mergeIntegration === "string" && mergeIntegration.length > 0
    ? mergeIntegration.toLowerCase()
    : "merge";
}

/**
 * SQL fragment (alias `rp`) that excludes raw_parsed rows already handled to a
 * terminal state for the CURRENT payload version: successfully projected
 * (`error IS NULL`) or quarantined, AND the log row recorded consuming the
 * same `rp.extracted_at` the row currently carries. A failed-but-not-
 * quarantined row is intentionally NOT excluded, so the next cycle retries
 * it. Used by every poll + the lag gauge so they agree on what "pending"
 * means.
 *
 * `IS NOT DISTINCT FROM` (NULL-safe equality) matters here: after migration
 * 0005's backfill, every log row that still points at a live raw_parsed row
 * carries that row's real extracted_at, so this comparison only sees NULL on
 * one side for an orphaned log row (its raw_parsed row was deleted, not
 * repaired) -- and an orphan's raw_parsed_id has no matching `rp` row in any
 * of these FROM-raw_parsed-driven queries, so it is never reached by this
 * predicate at all. No legacy row is spuriously re-pending.
 */
const PENDING_EXCLUSION = `NOT EXISTS (
            SELECT 1 FROM canonical_projection_log pl
             WHERE pl.raw_parsed_id = rp.id
               AND (pl.error IS NULL OR pl.quarantined)
               AND pl.parsed_extracted_at IS NOT DISTINCT FROM rp.extracted_at
          )`;

/**
 * Record a failed projection: increment the attempt counter and, once the retry
 * budget is exhausted, quarantine the row. Returns the post-update state so the
 * caller can emit a quarantine metric on the transition. Runs in its own
 * tenant-scoped transaction (the data transaction has already rolled back).
 *
 * `parsedExtractedAt` is the raw_parsed row's extracted_at as read during THIS
 * poll (not `now()`): stamping the version actually attempted, not the time of
 * the attempt, closes the read-then-write race where a repair lands mid-cycle.
 *
 * M5: `attempts` resets to 1 (a fresh retry budget) whenever the STORED
 * parsed_extracted_at differs from the one THIS attempt just consumed --
 * i.e. the payload changed since the last recorded failure. Without this a
 * quarantined row whose payload gets corrected keeps its exhausted counter,
 * so one transient failure re-quarantines it after a single attempt.
 */
async function recordFailure(
  pool: Pool,
  tenantId: string,
  rawParsedId: string,
  projector: string,
  domain: string,
  errorMessage: string,
  maxAttempts: number,
  parsedExtractedAt: string,
): Promise<{ attempts: number; quarantined: boolean }> {
  return withTenantScope(pool, tenantId, async (c) => {
    const { rows } = await c.query<{ attempts: number; quarantined: boolean }>(
      `INSERT INTO canonical_projection_log
         (raw_parsed_id, tenant_id, projector, domain, records_written, error, attempts, quarantined, parsed_extracted_at)
       VALUES ($1,$2,$3,$4,0,$5,1, 1 >= $6, $7::timestamp AT TIME ZONE 'UTC')
       ON CONFLICT (raw_parsed_id) DO UPDATE SET
         error = EXCLUDED.error,
         projector = EXCLUDED.projector,
         domain = EXCLUDED.domain,
         attempts = CASE
           WHEN canonical_projection_log.parsed_extracted_at IS DISTINCT FROM EXCLUDED.parsed_extracted_at
           THEN 1
           ELSE canonical_projection_log.attempts + 1
         END,
         quarantined = (CASE
           WHEN canonical_projection_log.parsed_extracted_at IS DISTINCT FROM EXCLUDED.parsed_extracted_at
           THEN 1
           ELSE canonical_projection_log.attempts + 1
         END) >= $6,
         parsed_extracted_at = EXCLUDED.parsed_extracted_at,
         projected_at = now()
       RETURNING attempts, quarantined`,
      [rawParsedId, tenantId, projector, domain, errorMessage, maxAttempts, parsedExtractedAt],
    );
    return rows[0] ?? { attempts: 1, quarantined: isQuarantined(1, maxAttempts) };
  });
}

/**
 * The canonical tables a raw_parsed page can produce records into, all
 * sharing the same (tenant_id, evidence_ids TEXT[], source_natural_key)
 * shape. A fixed allowlist (not caller input), so string-interpolating the
 * table name is safe.
 */
type OrphanCleanupTable =
  | "canonical_gl_account"
  | "canonical_journal_entry"
  | "canonical_account"
  | "canonical_transaction"
  | "canonical_counterparty"
  | "canonical_obligation";

/**
 * H3: a re-projection upserts every natural key the CURRENT payload still
 * contains, but nothing removes a canonical row for a key the payload
 * DROPPED or RENAMED (source_natural_key is the idempotency key; nothing
 * reacts to that key disappearing). That leaves corrected-away receivables
 * and orphaned OCR-typo'd counterparties in place.
 *
 * A prior version of this fix DELETEd those rows. Reverted -- it was unsound
 * three ways, not tunable:
 *   1. brain_canonical_projector has no DELETE grant on these tables
 *      (infra/db-roles.sql); granting one is explicitly forbidden (PR #330 +
 *      the runtime-db-roles.ts boot fence), so it would 500 every cycle in
 *      any environment that actually runs under the least-privilege role.
 *   2. Counterparty natural keys are shared across raw_parsed rows and every
 *      upsert overwrites evidence_ids wholesale (last writer owns it), so a
 *      scoped delete keyed on evidence_ids can drop the link for a sibling
 *      record this raw_parsed_id never touched.
 *   3. A degraded re-extraction (missing amount/type) legitimately produces
 *      an empty keep-set; deleting on that logs a terminal SUCCESS while a
 *      real payable silently vanishes -- worse than the bug this fixes.
 *
 * Converging correctly needs a real data-model change (many-to-many
 * evidence, or soft supersession with a superseded_at the read layer
 * filters) -- separate scoped work, not a rider here. Until then: detect,
 * count, log loudly, emit a metric, and still mark the projection terminal
 * (the caller's normal log write) so the projector doesn't hot-spin
 * retrying the same orphan every 15s. Destroying financial records is
 * strictly worse than a visible, measured inconsistency.
 */
async function detectOrphanedCanonicalRows(
  c: TenantScopedClient,
  deps: ProjectionWorkerDeps,
  table: OrphanCleanupTable,
  tenantId: string,
  rawParsedId: string,
  keepNaturalKeys: readonly string[],
): Promise<void> {
  const { rows } = await c.query<{ source_natural_key: string }>(
    `SELECT source_natural_key FROM ${table}
      WHERE tenant_id = $1
        AND evidence_ids @> ARRAY[$2]::text[]
        AND NOT (source_natural_key = ANY ($3::text[]))`,
    [tenantId, rawParsedId, [...keepNaturalKeys]],
  );
  if (rows.length === 0) return;
  const naturalKeys = rows.map((r) => r.source_natural_key);
  deps.metrics?.increment("brain.canonical.projector.orphaned_records", { table }, rows.length);
  deps.log?.warn(
    { tenantId, rawParsedId, table, naturalKeys, count: rows.length },
    "canonical projector: re-projection left orphaned records (not deleted; see H3 in worker.ts)",
  );
}

/** One full projection cycle. Exported for tests; startCanonicalProjectionWorker schedules it. */
export async function runProjectionCycle(
  deps: ProjectionWorkerDeps,
  opts?: ProjectionWorkerOptions,
): Promise<void> {
  const batchSize = opts?.batchSize ?? 20;
  const actor = opts?.actor ?? "sys_canonical_projector";
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_PROJECTION_ATTEMPTS;
  const rawParsedIds = opts?.rawParsedIds ?? [];
  const hasRawParsedFilter = rawParsedIds.length > 0;

  let rows: PendingParsedRow[];
  try {
    // Cross-tenant poll — requires BYPASSRLS or superuser in production.
    // Reference pages first so dependent rows can resolve in the same cycle.
    const values: unknown[] = [MERGE_ACCOUNTING_PARSER, [...ALL_PROJECTABLE_OBJECT_TYPES]];
    const rawParsedFilter = hasRawParsedFilter
      ? (() => {
          values.push([...rawParsedIds]);
          return `AND rp.id = ANY($${values.length}::text[])`;
        })()
      : "";
    values.push(batchSize);
    const result = await deps.pool.query<PendingParsedRow>(
      `SELECT rp.id, rp.raw_artifact_id, rp.tenant_id, rp.extracted, (rp.extracted_at AT TIME ZONE 'UTC')::text AS extracted_at
         FROM raw_parsed rp
        WHERE rp.parser = $1
          AND rp.extracted->>'object_type' = ANY($2::text[])
          ${rawParsedFilter}
          AND ${PENDING_EXCLUSION}
        ORDER BY CASE rp.extracted->>'object_type'
                   WHEN 'contact' THEN 0
                   WHEN 'gl_account' THEN 1
                   WHEN 'invoice' THEN 2
                   WHEN 'journal_entry' THEN 3
                   ELSE 9
                 END,
                 rp.extracted_at ASC
        LIMIT $${values.length}`,
      values,
    );
    rows = result.rows;
  } catch (err) {
    console.error("[canonicalProjector] poll query failed:", err);
    return;
  }

  for (const row of rows) {
    const objectType = row.extracted.object_type;
    const sourceSystem = sourceSystemOf(row.extracted.merge_integration);
    const objects = Array.isArray((row.extracted as { objects?: unknown }).objects)
      ? ((row.extracted as { objects: unknown[] }).objects as unknown[])
      : [];
    const common: ProjectionCommon = {
      provenance: "extracted",
      confidence: mergeConfidence(objectType),
      sourceIds: [row.raw_artifact_id],
      evidenceIds: [row.id],
    };

    const canonicalTable: OrphanCleanupTable | undefined =
      objectType === "gl_account"
        ? "canonical_gl_account"
        : objectType === "journal_entry"
          ? "canonical_journal_entry"
          : objectType === "contact"
            ? "canonical_counterparty"
            : objectType === "invoice"
              ? "canonical_obligation"
              : undefined;

    try {
      const written = await withTenantScope(deps.pool, row.tenant_id, async (c) => {
        let count = 0;
        const naturalKeys: string[] = [];
        for (const obj of objects) {
          if (objectType === "gl_account") {
            const input = projectGlAccount(obj, sourceSystem, common);
            if (input === null) continue;
            await upsertGlAccount(c, row.tenant_id, input);
            naturalKeys.push(input.sourceNaturalKey);
            count += 1;
          } else if (objectType === "journal_entry") {
            const input = projectJournalEntry(obj, sourceSystem, common);
            if (input === null) continue;
            await upsertJournalEntry(c, row.tenant_id, input);
            naturalKeys.push(input.sourceNaturalKey);
            count += 1;
          } else if (objectType === "contact") {
            const input = projectMergeContact(obj, sourceSystem, common);
            if (input === null) continue;
            await upsertCanonicalCounterparty(c, row.tenant_id, input);
            naturalKeys.push(input.sourceNaturalKey);
            count += 1;
          } else if (objectType === "invoice") {
            const input = projectMergeInvoice(obj, sourceSystem, common);
            if (input === null) continue;
            await upsertCanonicalObligation(c, row.tenant_id, input);
            naturalKeys.push(input.sourceNaturalKey);
            count += 1;
          }
        }
        // H3: detect (do not delete) canonical rows a corrected page dropped
        // or renamed. See detectOrphanedCanonicalRows.
        if (canonicalTable !== undefined) {
          await detectOrphanedCanonicalRows(
            c,
            deps,
            canonicalTable,
            row.tenant_id,
            row.id,
            naturalKeys,
          );
        }
        // Same transaction as the writes: log + data commit or roll back
        // together. On conflict (a prior failed attempt left a row) clear the
        // error/quarantine so a retry that finally succeeds is marked terminal.
        // parsed_extracted_at is stamped with the version read at poll time
        // (row.extracted_at), not now() -- see PENDING_EXCLUSION.
        await c.query(
          `INSERT INTO canonical_projection_log
             (raw_parsed_id, tenant_id, projector, domain, records_written, error, quarantined, parsed_extracted_at)
           VALUES ($1,$2,$3,$4,$5,NULL,false,$6::timestamp AT TIME ZONE 'UTC')
           ON CONFLICT (raw_parsed_id) DO UPDATE SET
             projector = EXCLUDED.projector,
             domain = EXCLUDED.domain,
             records_written = EXCLUDED.records_written,
             error = NULL,
             quarantined = false,
             parsed_extracted_at = EXCLUDED.parsed_extracted_at,
             projected_at = now()`,
          [
            row.id,
            row.tenant_id,
            MERGE_ACCOUNTING_PROJECTOR,
            domainFor(objectType),
            count,
            row.extracted_at,
          ],
        );
        return count;
      });

      await deps.audit.emit({
        tenantId: row.tenant_id,
        layer: "canonical",
        actor,
        action: "canonical.projected",
        inputs: {
          raw_parsed_id: row.id,
          projector: MERGE_ACCOUNTING_PROJECTOR,
          domain: domainFor(objectType),
          object_type: objectType ?? null,
          source_system: sourceSystem,
          extracted_sha256: sha256Hex(Buffer.from(JSON.stringify(row.extracted))),
        },
        outputs: { records_written: written },
      });
      deps.metrics?.increment(
        "brain.canonical.projector.records.count",
        { projector: MERGE_ACCOUNTING_PROJECTOR, object_type: objectType ?? "unknown" },
        written,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[canonicalProjector] projection failed for ${row.id}:`, message);
      await handleProjectionFailure(
        deps,
        row.tenant_id,
        row.id,
        MERGE_ACCOUNTING_PROJECTOR,
        domainFor(objectType),
        objectType ?? "unknown",
        message,
        maxAttempts,
        row.extracted_at,
      );
    }
  }

  await runDocObligationPass(deps, batchSize, actor, maxAttempts, rawParsedIds);
  await runConnectorLedgerPasses(deps, batchSize, actor, maxAttempts, rawParsedIds);
  if (!hasRawParsedFilter) await emitProjectorLag(deps);
}

/**
 * Persist a projection failure and, when it tips a row into quarantine, surface
 * it via metrics + log so a poison record is visible rather than silently
 * dropped. Swallows logging errors (best effort; the row stays pollable).
 */
async function handleProjectionFailure(
  deps: ProjectionWorkerDeps,
  tenantId: string,
  rawParsedId: string,
  projector: string,
  domain: string,
  objectType: string,
  message: string,
  maxAttempts: number,
  parsedExtractedAt: string,
): Promise<void> {
  try {
    const state = await recordFailure(
      deps.pool,
      tenantId,
      rawParsedId,
      projector,
      domain,
      message,
      maxAttempts,
      parsedExtractedAt,
    );
    if (state.quarantined) {
      console.error(
        `[canonicalProjector] quarantined ${rawParsedId} after ${state.attempts} attempts: ${message}`,
      );
      deps.metrics?.increment(
        "brain.canonical.projector.quarantine.count",
        { projector, object_type: objectType },
        1,
      );
    }
  } catch (logErr) {
    console.error(`[canonicalProjector] failed to log projection for ${rawParsedId}:`, logErr);
  }
}

/**
 * Gauge the age of the oldest unconsumed projectable raw_parsed row, so a
 * stalled projector surfaces as rising lag (not just a flatlined record count).
 * 0 when there is no backlog.
 */
async function emitProjectorLag(deps: ProjectionWorkerDeps): Promise<void> {
  if (deps.metrics === undefined) return;
  try {
    // Lag counts rows still pending (not yet terminal). Quarantined rows are
    // terminal, so a poison record no longer inflates lag forever. Its backlog
    // moves to the quarantine-depth gauge below instead.
    const { rows } = await deps.pool.query<{ lag: number }>(
      `SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(rp.extracted_at)), 0)::float8 AS lag
         FROM raw_parsed rp
        WHERE ((rp.parser = $1 AND rp.extracted->>'object_type' = ANY($2::text[]))
               OR rp.parser = $3
               OR rp.parser = ANY($4::text[]))
          AND ${PENDING_EXCLUSION}`,
      [
        MERGE_ACCOUNTING_PARSER,
        [...ALL_PROJECTABLE_OBJECT_TYPES],
        DOC_OBLIGATION_PARSER,
        CONNECTOR_LEDGER_PASSES.map((p) => p.parser),
      ],
    );
    deps.metrics.gauge("brain.canonical.projector.lag_seconds", rows[0]?.lag ?? 0);
  } catch (err) {
    console.error("[canonicalProjector] lag gauge query failed:", err);
  }
  try {
    const { rows } = await deps.pool.query<{ depth: number }>(
      `SELECT count(*)::int AS depth FROM canonical_projection_log WHERE quarantined`,
    );
    deps.metrics.gauge("brain.canonical.projector.quarantine.depth", rows[0]?.depth ?? 0);
  } catch (err) {
    console.error("[canonicalProjector] quarantine depth gauge query failed:", err);
  }
}

interface PendingConnectorRow {
  id: string;
  raw_artifact_id: string;
  tenant_id: string;
  extracted: Record<string, unknown>;
  confidence: number | null;
  // See PendingParsedRow.extracted_at: kept as the ::text the poll selected,
  // not a driver-parsed Date, to preserve microsecond precision.
  extracted_at: string;
}

async function persistConnectorProjection(
  c: TenantScopedClient,
  tenantId: string,
  projection: ConnectorLedgerProjection,
): Promise<void> {
  if (projection.kind === "account") {
    await upsertCanonicalAccount(c, tenantId, projection.input);
  } else if (projection.kind === "transaction") {
    await upsertCanonicalTransaction(c, tenantId, projection.input);
  } else if (projection.kind === "counterparty") {
    await upsertCanonicalCounterparty(c, tenantId, projection.input);
  } else {
    await upsertCanonicalObligation(c, tenantId, projection.input);
  }
}

function isUploadProjector(projector: string): boolean {
  return (
    projector === BANK_STATEMENT_UPLOAD_PROJECTOR ||
    projector === DOCUMENT_RECORDS_UPLOAD_PROJECTOR ||
    projector === BANK_STATEMENT_UPLOAD_PARSER ||
    projector === DOCUMENT_RECORDS_UPLOAD_PARSER
  );
}

function summarizeUploadProjection(
  projections: readonly ConnectorLedgerProjection[],
): LedgerUploadProjectionSummary {
  let accounts = 0;
  let transactions = 0;
  let receivables = 0;
  let obligations = 0;
  let newCounterparties = 0;
  for (const projection of projections) {
    if (projection.kind === "account") accounts += 1;
    if (projection.kind === "transaction") transactions += 1;
    if (projection.kind === "counterparty") newCounterparties += 1;
    if (projection.kind === "obligation") {
      obligations += 1;
      if (projection.input.direction === "receivable") receivables += 1;
    }
  }
  return { accounts, transactions, receivables, obligations, newCounterparties };
}

function hasProjectedRows(summary: LedgerUploadProjectionSummary): boolean {
  return (
    summary.accounts +
      summary.transactions +
      summary.receivables +
      summary.obligations +
      summary.newCounterparties >
    0
  );
}

async function runConnectorLedgerPasses(
  deps: ProjectionWorkerDeps,
  batchSize: number,
  actor: string,
  maxAttempts: number,
  rawParsedIds: readonly string[] = [],
): Promise<void> {
  for (const pass of CONNECTOR_LEDGER_PASSES) {
    let rows: PendingConnectorRow[];
    try {
      const values: unknown[] = [pass.parser];
      const rawParsedFilter =
        rawParsedIds.length > 0
          ? (() => {
              values.push([...rawParsedIds]);
              return `AND rp.id = ANY($${values.length}::text[])`;
            })()
          : "";
      values.push(batchSize);
      const result = await deps.pool.query<PendingConnectorRow>(
        `SELECT rp.id, rp.raw_artifact_id, rp.tenant_id, rp.extracted, rp.confidence, (rp.extracted_at AT TIME ZONE 'UTC')::text AS extracted_at
           FROM raw_parsed rp
          WHERE rp.parser = $1
            ${rawParsedFilter}
            AND ${PENDING_EXCLUSION}
          ORDER BY rp.extracted_at ASC
          LIMIT $${values.length}`,
        values,
      );
      rows = result.rows;
    } catch (err) {
      console.error(`[canonicalProjector] ${pass.parser} poll failed:`, err);
      continue;
    }

    for (const row of rows) {
      const common: ProjectionCommon = {
        provenance: "extracted",
        confidence: row.confidence,
        sourceIds: [row.raw_artifact_id],
        evidenceIds: [row.id],
      };
      try {
        const written = await withTenantScope(deps.pool, row.tenant_id, async (c) => {
          const diagnostics: ConnectorProjectionDiagnostics = { skippedRows: {} };
          const projections = pass.project(row.extracted, common, diagnostics);
          const summary = summarizeUploadProjection(projections);
          let count = 0;
          const naturalKeysByKind: Record<ConnectorLedgerProjection["kind"], string[]> = {
            account: [],
            transaction: [],
            counterparty: [],
            obligation: [],
          };
          for (const projection of projections) {
            await persistConnectorProjection(c, row.tenant_id, projection);
            naturalKeysByKind[projection.kind].push(projection.input.sourceNaturalKey);
            count += 1;
          }
          // H3: detect (do not delete) orphans across all 4 target tables,
          // even ones with zero projections THIS cycle (e.g. a correction
          // removes the only account). See detectOrphanedCanonicalRows.
          await detectOrphanedCanonicalRows(
            c,
            deps,
            "canonical_account",
            row.tenant_id,
            row.id,
            naturalKeysByKind.account,
          );
          await detectOrphanedCanonicalRows(
            c,
            deps,
            "canonical_transaction",
            row.tenant_id,
            row.id,
            naturalKeysByKind.transaction,
          );
          await detectOrphanedCanonicalRows(
            c,
            deps,
            "canonical_counterparty",
            row.tenant_id,
            row.id,
            naturalKeysByKind.counterparty,
          );
          await detectOrphanedCanonicalRows(
            c,
            deps,
            "canonical_obligation",
            row.tenant_id,
            row.id,
            naturalKeysByKind.obligation,
          );
          await c.query(
            `INSERT INTO canonical_projection_log
               (raw_parsed_id, tenant_id, projector, domain, records_written, error, quarantined, parsed_extracted_at)
             VALUES ($1,$2,$3,'ledger',$4,NULL,false,$5::timestamp AT TIME ZONE 'UTC')
             ON CONFLICT (raw_parsed_id) DO UPDATE SET
               projector = EXCLUDED.projector,
               domain = EXCLUDED.domain,
               records_written = EXCLUDED.records_written,
               error = NULL,
               quarantined = false,
               parsed_extracted_at = EXCLUDED.parsed_extracted_at,
               projected_at = now()`,
            [row.id, row.tenant_id, pass.projector, count, row.extracted_at],
          );
          return { count, skippedRows: diagnostics.skippedRows, summary };
        });

        await deps.audit.emit({
          tenantId: row.tenant_id,
          layer: "canonical",
          actor,
          action: "canonical.projected",
          inputs: {
            raw_parsed_id: row.id,
            projector: pass.projector,
            domain: "ledger",
            object_type: pass.objectType,
            source_system: pass.objectType,
            extracted_sha256: sha256Hex(Buffer.from(JSON.stringify(row.extracted))),
          },
          outputs: { records_written: written.count },
        });
        deps.metrics?.increment(
          "brain.canonical.projector.records.count",
          { projector: pass.projector, object_type: pass.objectType },
          written.count,
        );
        if (isUploadProjector(pass.projector) && hasProjectedRows(written.summary)) {
          await deps.audit.emit({
            tenantId: row.tenant_id,
            layer: "ledger",
            eventType: "system_activity",
            severity: "info",
            actor,
            action: "ledger.upload.projected",
            inputs: {
              raw_artifact_id: row.raw_artifact_id,
              raw_parsed_id: row.id,
              projector: pass.projector,
            },
            outputs: { summary: written.summary },
          });
        }
        if (
          deps.onUploadProjected !== undefined &&
          isUploadProjector(pass.projector) &&
          hasProjectedRows(written.summary)
        ) {
          try {
            await deps.onUploadProjected({
              event: "ledger.upload.projected",
              tenantId: row.tenant_id,
              rawArtifactId: row.raw_artifact_id,
              rawParsedId: row.id,
              projector: pass.projector,
              summary: written.summary,
            });
          } catch (err) {
            console.error(
              `[canonicalProjector] upload projection trigger failed for ${row.id}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
        for (const [reason, count] of Object.entries(written.skippedRows)) {
          if (count <= 0) continue;
          deps.metrics?.increment(
            "brain.canonical.connector.skipped_row.count",
            { projector: pass.projector, object_type: pass.objectType, reason },
            count,
          );
          deps.log?.debug(
            { parser: pass.parser, projector: pass.projector, reason, count },
            "canonical connector projection skipped rows",
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[canonicalProjector] ${pass.parser} projection failed for ${row.id}:`,
          message,
        );
        await handleProjectionFailure(
          deps,
          row.tenant_id,
          row.id,
          pass.projector,
          "ledger",
          pass.objectType,
          message,
          maxAttempts,
          row.extracted_at,
        );
      }
    }
  }
}

interface PendingDocRow {
  id: string;
  raw_artifact_id: string;
  tenant_id: string;
  extracted: Record<string, unknown>;
  confidence: number | null;
  // See PendingParsedRow.extracted_at: kept as the ::text the poll selected,
  // not a driver-parsed Date, to preserve microsecond precision.
  extracted_at: string;
}

/**
 * Project RFC 0004 document-extracted obligations into canonical AP/AR. These
 * are low-trust (agent_contributed, confidence from the raw_parsed row, capped),
 * so the §6 gate still refuses auto-execution on document-only evidence.
 */
async function runDocObligationPass(
  deps: ProjectionWorkerDeps,
  batchSize: number,
  actor: string,
  maxAttempts: number,
  rawParsedIds: readonly string[] = [],
): Promise<void> {
  let rows: PendingDocRow[];
  try {
    const values: unknown[] = [DOC_OBLIGATION_PARSER];
    const rawParsedFilter =
      rawParsedIds.length > 0
        ? (() => {
            values.push([...rawParsedIds]);
            return `AND rp.id = ANY($${values.length}::text[])`;
          })()
        : "";
    values.push(batchSize);
    const result = await deps.pool.query<PendingDocRow>(
      `SELECT rp.id, rp.raw_artifact_id, rp.tenant_id, rp.extracted, rp.confidence, (rp.extracted_at AT TIME ZONE 'UTC')::text AS extracted_at
         FROM raw_parsed rp
        WHERE rp.parser = $1
          ${rawParsedFilter}
          AND ${PENDING_EXCLUSION}
        ORDER BY rp.extracted_at ASC
        LIMIT $${values.length}`,
      values,
    );
    rows = result.rows;
  } catch (err) {
    console.error("[canonicalProjector] doc poll failed:", err);
    return;
  }

  for (const row of rows) {
    const common: ProjectionCommon = {
      provenance: "agent_contributed",
      confidence: row.confidence ?? DOC_DEFAULT_CONFIDENCE,
      sourceIds: [row.raw_artifact_id],
      evidenceIds: [row.id],
    };
    try {
      const written = await withTenantScope(deps.pool, row.tenant_id, async (c) => {
        const projected = projectDocObligation(row.extracted, row.raw_artifact_id, common);
        let count = 0;
        if (projected !== null) {
          await upsertCanonicalCounterparty(c, row.tenant_id, projected.counterparty);
          await upsertCanonicalObligation(c, row.tenant_id, projected.obligation);
          count = 1;
        }
        // H3: detect (do not delete) orphans -- a correction that now
        // resolves to a different (OCR fix) or no counterparty/obligation.
        // See detectOrphanedCanonicalRows.
        await detectOrphanedCanonicalRows(
          c,
          deps,
          "canonical_counterparty",
          row.tenant_id,
          row.id,
          projected !== null ? [projected.counterparty.sourceNaturalKey] : [],
        );
        await detectOrphanedCanonicalRows(
          c,
          deps,
          "canonical_obligation",
          row.tenant_id,
          row.id,
          projected !== null ? [projected.obligation.sourceNaturalKey] : [],
        );
        await c.query(
          `INSERT INTO canonical_projection_log
             (raw_parsed_id, tenant_id, projector, domain, records_written, error, quarantined, parsed_extracted_at)
           VALUES ($1,$2,$3,'ap_ar',$4,NULL,false,$5::timestamp AT TIME ZONE 'UTC')
           ON CONFLICT (raw_parsed_id) DO UPDATE SET
             projector = EXCLUDED.projector,
             records_written = EXCLUDED.records_written,
             error = NULL,
             quarantined = false,
             parsed_extracted_at = EXCLUDED.parsed_extracted_at,
             projected_at = now()`,
          [row.id, row.tenant_id, DOC_OBLIGATION_PROJECTOR, count, row.extracted_at],
        );
        return count;
      });

      await deps.audit.emit({
        tenantId: row.tenant_id,
        layer: "canonical",
        actor,
        action: "canonical.projected",
        inputs: {
          raw_parsed_id: row.id,
          projector: DOC_OBLIGATION_PROJECTOR,
          domain: "ap_ar",
          object_type: "doc_obligation",
          source_system: "document",
          extracted_sha256: sha256Hex(Buffer.from(JSON.stringify(row.extracted))),
        },
        outputs: { records_written: written },
      });
      deps.metrics?.increment(
        "brain.canonical.projector.records.count",
        { projector: DOC_OBLIGATION_PROJECTOR, object_type: "doc_obligation" },
        written,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[canonicalProjector] doc projection failed for ${row.id}:`, message);
      await handleProjectionFailure(
        deps,
        row.tenant_id,
        row.id,
        DOC_OBLIGATION_PROJECTOR,
        "ap_ar",
        "doc_obligation",
        message,
        maxAttempts,
        row.extracted_at,
      );
    }
  }
}

/**
 * Bounded replay/drain of quarantined projection rows: clears the quarantine
 * flag and resets the retry budget so the next cycle re-attempts them (the
 * `error` is kept non-null so the row stays pollable until that attempt
 * overwrites it). Run after fixing the projector bug that caused the poison.
 * Returns the number of rows released.
 *
 * With `tenantId` the drain is tenant-scoped (RLS-enforced); without it the
 * drain is cross-tenant (privileged pool) for a platform-operator sweep.
 */
export async function replayQuarantined(
  deps: ProjectionWorkerDeps,
  opts?: { tenantId?: string; limit?: number },
): Promise<number> {
  const limit = opts?.limit ?? 100;
  const sql = `UPDATE canonical_projection_log
                  SET quarantined = false, attempts = 0
                WHERE raw_parsed_id IN (
                  SELECT raw_parsed_id FROM canonical_projection_log
                   WHERE quarantined = true
                   ORDER BY projected_at ASC
                   LIMIT $1
                )`;
  if (opts?.tenantId !== undefined) {
    return withTenantScope(deps.pool, opts.tenantId, async (c) => {
      const res = await c.query(sql, [limit]);
      return res.rowCount ?? 0;
    });
  }
  const res = await deps.pool.query(sql, [limit]);
  return res.rowCount ?? 0;
}

export function startCanonicalProjectionWorker(
  deps: ProjectionWorkerDeps,
  opts?: ProjectionWorkerOptions,
): ProjectionWorker {
  const intervalMs = opts?.intervalMs ?? 15_000;
  // Advisory lease: only one replica projects at a time (multi-replica safe).
  return startManagedInterval(
    leasedCycle({
      pool: deps.pool,
      lockKey: "brain_worker_canonical_projection",
      cycle: () => runProjectionCycle(deps, opts),
      name: "canonical-projector",
      metrics: deps.metrics,
    }),
    intervalMs,
    {
      name: "canonical-projector",
      runImmediately: true,
      onError: (err) => console.error("[canonicalProjector] cycle failed:", err),
    },
  );
}
