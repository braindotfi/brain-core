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
