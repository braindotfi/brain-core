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
  withTenantScope,
  type AuditEmitter,
  type ManagedWorker,
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
import { upsertCanonicalCounterparty, upsertCanonicalObligation } from "../repository/apar.js";

export interface ProjectionWorkerDeps {
  pool: Pool;
  audit: AuditEmitter;
}

export interface ProjectionWorkerOptions {
  /** Polling interval in milliseconds. Default: 15 000 (15 s). */
  intervalMs?: number;
  /** Maximum raw_parsed rows per poll cycle. Default: 20. */
  batchSize?: number;
  /** Actor id attributed to projection audit events. */
  actor?: string;
}

export type ProjectionWorker = ManagedWorker;

interface PendingParsedRow {
  id: string;
  raw_artifact_id: string;
  tenant_id: string;
  extracted: { object_type?: string; merge_integration?: string | null };
}

// Object types this worker projects, across both canonical domains served by
// the merge_accounting_v1 parser. Counterparty/GL pages sort ahead of the
// obligation/journal pages that reference them (object_type ASC: contact,
// gl_account, invoice, journal_entry), so references resolve in one cycle.
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

async function recordProjection(
  pool: Pool,
  tenantId: string,
  rawParsedId: string,
  domain: string,
  recordsWritten: number,
  errorMessage: string | null,
): Promise<void> {
  await withTenantScope(pool, tenantId, async (c) => {
    await c.query(
      `INSERT INTO canonical_projection_log
         (raw_parsed_id, tenant_id, projector, domain, records_written, error)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (raw_parsed_id) DO NOTHING`,
      [rawParsedId, tenantId, MERGE_ACCOUNTING_PROJECTOR, domain, recordsWritten, errorMessage],
    );
  });
}

/** One full projection cycle. Exported for tests; startCanonicalProjectionWorker schedules it. */
export async function runProjectionCycle(
  deps: ProjectionWorkerDeps,
  opts?: ProjectionWorkerOptions,
): Promise<void> {
  const batchSize = opts?.batchSize ?? 20;
  const actor = opts?.actor ?? "sys_canonical_projector";

  let rows: PendingParsedRow[];
  try {
    // Cross-tenant poll — requires BYPASSRLS or superuser in production.
    // gl_account pages first so journal lines can resolve their GL reference.
    const result = await deps.pool.query<PendingParsedRow>(
      `SELECT rp.id, rp.raw_artifact_id, rp.tenant_id, rp.extracted
         FROM raw_parsed rp
        WHERE rp.parser = $1
          AND rp.extracted->>'object_type' = ANY($2::text[])
          AND NOT EXISTS (
            SELECT 1 FROM canonical_projection_log pl WHERE pl.raw_parsed_id = rp.id
          )
        ORDER BY rp.extracted->>'object_type' ASC, rp.extracted_at ASC
        LIMIT $3`,
      [MERGE_ACCOUNTING_PARSER, [...ALL_PROJECTABLE_OBJECT_TYPES], batchSize],
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
      confidence: null,
      sourceIds: [row.raw_artifact_id],
      evidenceIds: [row.id],
    };

    try {
      const written = await withTenantScope(deps.pool, row.tenant_id, async (c) => {
        let count = 0;
        for (const obj of objects) {
          if (objectType === "gl_account") {
            const input = projectGlAccount(obj, sourceSystem, common);
            if (input === null) continue;
            await upsertGlAccount(c, row.tenant_id, input);
            count += 1;
          } else if (objectType === "journal_entry") {
            const input = projectJournalEntry(obj, sourceSystem, common);
            if (input === null) continue;
            await upsertJournalEntry(c, row.tenant_id, input);
            count += 1;
          } else if (objectType === "contact") {
            const input = projectMergeContact(obj, sourceSystem, common);
            if (input === null) continue;
            await upsertCanonicalCounterparty(c, row.tenant_id, input);
            count += 1;
          } else if (objectType === "invoice") {
            const input = projectMergeInvoice(obj, sourceSystem, common);
            if (input === null) continue;
            await upsertCanonicalObligation(c, row.tenant_id, input);
            count += 1;
          }
        }
        // Same transaction as the writes: log + data commit or roll back together.
        await c.query(
          `INSERT INTO canonical_projection_log
             (raw_parsed_id, tenant_id, projector, domain, records_written, error)
           VALUES ($1,$2,$3,$4,$5,NULL)
           ON CONFLICT (raw_parsed_id) DO NOTHING`,
          [row.id, row.tenant_id, MERGE_ACCOUNTING_PROJECTOR, domainFor(objectType), count],
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[canonicalProjector] projection failed for ${row.id}:`, message);
      try {
        await recordProjection(deps.pool, row.tenant_id, row.id, domainFor(objectType), 0, message);
      } catch (logErr) {
        console.error(`[canonicalProjector] failed to log projection for ${row.id}:`, logErr);
      }
    }
  }
}

export function startCanonicalProjectionWorker(
  deps: ProjectionWorkerDeps,
  opts?: ProjectionWorkerOptions,
): ProjectionWorker {
  const intervalMs = opts?.intervalMs ?? 15_000;
  return startManagedInterval(() => runProjectionCycle(deps, opts), intervalMs, {
    name: "canonical-projector",
    runImmediately: true,
    onError: (err) => console.error("[canonicalProjector] cycle failed:", err),
  });
}
