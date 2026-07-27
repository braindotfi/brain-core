/**
 * raw_parsed repository. Populated by stage-3 extractors; this layer
 * exists in stage-2 so that /raw/{raw_id}/parsed can return an empty
 * list rather than 501.
 */

import { stableStringify, type TenantScopedClient } from "@brain/shared";

export interface RawParsedRow {
  id: string;
  raw_artifact_id: string;
  tenant_id: string;
  parser: string;
  parser_version: string;
  extracted: Record<string, unknown>;
  confidence: number | null;
  extracted_at: Date;
}

export interface ListParsedFilters {
  parser?: string;
  parserVersion?: string;
}

export async function listParsedByArtifact(
  client: TenantScopedClient,
  artifactId: string,
  filters: ListParsedFilters = {},
): Promise<RawParsedRow[]> {
  const where: string[] = ["raw_artifact_id = $1"];
  const values: unknown[] = [artifactId];
  if (filters.parser !== undefined) {
    values.push(filters.parser);
    where.push(`parser = $${values.length}`);
  }
  if (filters.parserVersion !== undefined) {
    values.push(filters.parserVersion);
    where.push(`parser_version = $${values.length}`);
  }
  const { rows } = await client.query<RawParsedRow>(
    `SELECT * FROM raw_parsed WHERE ${where.join(" AND ")} ORDER BY extracted_at DESC`,
    values,
  );
  return rows;
}

export async function hasValidParsedForArtifact(
  client: TenantScopedClient,
  artifactId: string,
  options: {
    acceptedParsers?: readonly string[];
    excludeTerminalZeroProjection?: boolean;
  } = {},
): Promise<boolean> {
  const where = ["rp.raw_artifact_id = $1", "rp.parser IS NOT NULL"];
  const values: unknown[] = [artifactId];
  if (options.acceptedParsers !== undefined) {
    values.push([...options.acceptedParsers]);
    where.push(`rp.parser = ANY($${values.length}::text[])`);
  }
  if (options.excludeTerminalZeroProjection === true) {
    where.push(`NOT EXISTS (
      SELECT 1
        FROM canonical_projection_log cpl
       WHERE cpl.raw_parsed_id = rp.id
         AND cpl.records_written = 0
         AND cpl.error IS NULL
         AND COALESCE(cpl.quarantined, false) = false
    )`);
  }

  const { rows } = await client.query<{ count: string | number }>(
    `SELECT COUNT(*)::int AS count
       FROM raw_parsed rp
      WHERE ${where.join(" AND ")}`,
    values,
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

export interface InsertParsedInput {
  id: string;
  rawArtifactId: string;
  tenantId: string;
  parser: string;
  parserVersion: string;
  extracted: Record<string, unknown>;
  confidence: number | null;
  /**
   * Opt-in for the repair paths below (stale/shape/content-diff/zero-row-log
   * overwrite of an existing raw_parsed row). Set ONLY by the trusted,
   * deterministic re-extraction callers (services/api/src/raw-extract/
   * worker.ts, services/raw/src/workers/interpretWorker.ts) that re-derive
   * `extracted` from the immutable raw bytes themselves.
   *
   * MUST stay unset/false for services/raw/src/routes/parsed.ts (POST
   * /raw/:raw_id/parsed): that route accepts `extracted` verbatim from an
   * ordinary raw:write-scoped caller, so any repair trigger reachable from it
   * would let that caller overwrite Raw's supposedly-immutable evidence with
   * arbitrary content -- and silently invalidate the raw.parsed.write audit
   * event's extracted_sha256, which would no longer match what the row
   * actually contains. Without allowRepair, insertParsed's contract for the
   * route stays exactly "immutable per (artifact, parser, version)".
   */
  allowRepair?: boolean;
}

/**
 * Insert one parser-output row (the stage-3 producer of raw_parsed).
 *
 * Normal re-posts stay immutable per (artifact, parser, version). The
 * exception -- gated by `allowRepair`, see InsertParsedInput -- is a parser
 * correction for a previously stranded upload row: if there is one stale row
 * for the same artifact/version, or the exact row's upload payload shape or
 * content changed, or the exact row has a terminal zero-row projection log,
 * update the derived parser output. Bumping extracted_at is now sufficient
 * for canonical projection to replay it (the projector's pending gate
 * compares raw_parsed.extracted_at against the version each
 * canonical_projection_log row consumed), so this no longer deletes the log
 * row itself.
 */
export async function insertParsed(
  client: TenantScopedClient,
  input: InsertParsedInput,
): Promise<{ row: RawParsedRow; created: boolean }> {
  const canRepair = input.allowRepair === true;

  const exact = await findParsedByArtifactParserVersion(client, input);
  if (exact !== undefined) {
    if (
      canRepair &&
      (shouldRepairParsedOutput(exact, input) ||
        (await hasTerminalZeroProjectionLog(client, exact.id)))
    ) {
      return { row: await repairParsedOutput(client, exact, input), created: false };
    }
    return { row: exact, created: false };
  }

  if (canRepair) {
    const stale = await client.query<RawParsedRow>(
      `SELECT * FROM raw_parsed
        WHERE raw_artifact_id = $1
          AND parser_version = $2
          AND parser IS DISTINCT FROM $3
        ORDER BY extracted_at DESC
        LIMIT 2`,
      [input.rawArtifactId, input.parserVersion, input.parser],
    );
    if (stale.rows.length === 1) {
      const row = await repairParsedOutput(client, stale.rows[0]!, input);
      return { row, created: false };
    }
  }

  const { rows } = await client.query<RawParsedRow>(
    `INSERT INTO raw_parsed
       (id, raw_artifact_id, tenant_id, parser, parser_version, extracted, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (raw_artifact_id, parser, parser_version) DO NOTHING
     RETURNING *`,
    [
      input.id,
      input.rawArtifactId,
      input.tenantId,
      input.parser,
      input.parserVersion,
      JSON.stringify(input.extracted),
      input.confidence,
    ],
  );
  const inserted = rows[0];
  if (inserted !== undefined) return { row: inserted, created: true };

  // Conflict from a concurrent writer: the exact row now exists. Return it,
  // unless a prior zero-row projection log proves the row must be replayed.
  const row = await findParsedByArtifactParserVersion(client, input);
  if (row === undefined) {
    throw new Error("raw_parsed insert hit a conflict but no existing row was found");
  }
  if (canRepair && (await hasTerminalZeroProjectionLog(client, row.id))) {
    return { row: await repairParsedOutput(client, row, input), created: false };
  }
  return { row, created: false };
}

async function findParsedByArtifactParserVersion(
  client: TenantScopedClient,
  input: InsertParsedInput,
): Promise<RawParsedRow | undefined> {
  const { rows } = await client.query<RawParsedRow>(
    `SELECT * FROM raw_parsed
      WHERE raw_artifact_id = $1 AND parser = $2 AND parser_version = $3
      LIMIT 1`,
    [input.rawArtifactId, input.parser, input.parserVersion],
  );
  return rows[0];
}

async function hasTerminalZeroProjectionLog(
  client: TenantScopedClient,
  parsedId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM canonical_projection_log
        WHERE raw_parsed_id = $1
          AND records_written = 0
          AND error IS NULL
          AND COALESCE(quarantined, false) = false
     ) AS exists`,
    [parsedId],
  );
  return rows[0]?.exists === true;
}

async function repairParsedOutput(
  client: TenantScopedClient,
  existing: RawParsedRow,
  input: InsertParsedInput,
): Promise<RawParsedRow> {
  const { rows } = await client.query<RawParsedRow>(
    `UPDATE raw_parsed
        SET parser = $2,
            parser_version = $3,
            extracted = $4,
            confidence = $5,
            extracted_at = now()
      WHERE id = $1
        AND raw_artifact_id = $6
        AND tenant_id = $7
      RETURNING *`,
    [
      existing.id,
      input.parser,
      input.parserVersion,
      JSON.stringify(input.extracted),
      input.confidence,
      input.rawArtifactId,
      input.tenantId,
    ],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("raw_parsed repair failed to return the existing row");
  }
  return row;
}

/**
 * Repair an exact upload-parser match when either its payload shape is stale
 * (old bug: wrong object_type for the parser) or its content has since changed
 * (a fixed interpreter now returns different data for the same shape, e.g. 3
 * transactions -> 40). Without the content check a corrected same-shape
 * payload was silently dropped: insertParsed's exact-match branch returned the
 * stale row unchanged.
 */
function shouldRepairParsedOutput(existing: RawParsedRow, input: InsertParsedInput): boolean {
  return (
    isUploadParser(input.parser) &&
    (!uploadParsedPayloadMatches(input.parser, existing.extracted) ||
      extractedPayloadChanged(existing.extracted, input.extracted))
  );
}

/**
 * Order-insensitive deep-equality check. Uses the shared audit-hash
 * stableStringify (shared/src/audit/hash.ts) rather than a third local copy.
 */
function extractedPayloadChanged(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): boolean {
  return (
    stableStringify(normalizeForCompare(existing)) !==
    stableStringify(normalizeForCompare(incoming))
  );
}

/**
 * M2: the shared stableStringify throws a TypeError on `undefined` (in key
 * or array position). `extracted` is untrusted-shaped JSON from an
 * interpreter or an HTTP body, and at least one interpreter can legitimately
 * produce an `undefined` field (services/raw/src/interpreters/upload.ts's
 * AR-aging rows before its own fix) -- an uncaught throw here would kill the
 * whole insertParsed call, not just the repair check. JSON.parse(JSON.
 * stringify(x)) is the defensive normalization: it drops undefined object
 * keys and turns undefined array elements into null, exactly matching how
 * the value would already look after a real round-trip through the
 * extracted JSONB column.
 */
function normalizeForCompare(
  value: Record<string, unknown>,
): Parameters<typeof stableStringify>[0] {
  return JSON.parse(JSON.stringify(value)) as Parameters<typeof stableStringify>[0];
}

function isUploadParser(parser: string): boolean {
  return parser === "bank_statement_upload_v1" || parser === "document_records_upload_v1";
}

function uploadParsedPayloadMatches(parser: string, extracted: Record<string, unknown>): boolean {
  const objectType = extracted["object_type"];
  if (parser === "bank_statement_upload_v1") return objectType === "bank_statement";
  if (parser === "document_records_upload_v1") {
    return objectType === "ar_aging" || objectType === "payroll_register";
  }
  return true;
}
