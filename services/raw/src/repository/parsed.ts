/**
 * raw_parsed repository. Populated by stage-3 extractors; this layer
 * exists in stage-2 so that /raw/{raw_id}/parsed can return an empty
 * list rather than 501.
 */

import type { TenantScopedClient } from "@brain/shared";

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
}

/**
 * Insert one parser-output row (the stage-3 producer of raw_parsed).
 *
 * Normal re-posts stay immutable per (artifact, parser, version). The exception
 * is a parser correction for a previously stranded upload row: if there is one
 * stale row for the same artifact/version, or if the exact row has a terminal
 * zero-row projection log, update the derived parser output and clear the log
 * so canonical projection can replay it.
 */
export async function insertParsed(
  client: TenantScopedClient,
  input: InsertParsedInput,
): Promise<{ row: RawParsedRow; created: boolean }> {
  const exact = await findParsedByArtifactParserVersion(client, input);
  if (exact !== undefined) {
    if (await hasTerminalZeroProjectionLog(client, exact.id)) {
      return { row: await repairParsedOutput(client, exact, input), created: false };
    }
    return { row: exact, created: false };
  }

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
  if (await hasTerminalZeroProjectionLog(client, row.id)) {
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
  await client.query(`DELETE FROM canonical_projection_log WHERE raw_parsed_id = $1`, [row.id]);
  return row;
}
