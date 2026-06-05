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
 * Insert one parser-output row (the stage-3 producer of raw_parsed). Naturally
 * idempotent on the (raw_artifact_id, parser, parser_version) UNIQUE key: a
 * re-post returns the existing row with `created: false` and never mutates it,
 * so the parser output stays immutable per (artifact, parser, version).
 */
export async function insertParsed(
  client: TenantScopedClient,
  input: InsertParsedInput,
): Promise<{ row: RawParsedRow; created: boolean }> {
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

  // Conflict: the (artifact, parser, version) row already exists. Return it.
  const existing = await client.query<RawParsedRow>(
    `SELECT * FROM raw_parsed
      WHERE raw_artifact_id = $1 AND parser = $2 AND parser_version = $3
      LIMIT 1`,
    [input.rawArtifactId, input.parser, input.parserVersion],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    throw new Error("raw_parsed insert hit a conflict but no existing row was found");
  }
  return { row, created: false };
}
