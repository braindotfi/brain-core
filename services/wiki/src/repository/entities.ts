/**
 * wiki_entities repository. Bitemporal: valid_from/valid_to model.
 *
 * Invariant: at most one row per "logical entity" has valid_to IS NULL at
 * any given time. New versions are written via insertNewVersion() which
 * closes off the prior version's valid_to atomically inside a TX.
 */

import type { TenantScopedClient } from "@brain/api/shared";
import { AGENT_CONTRIBUTED_CONFIDENCE_CEILING, type EntityKind, type Provenance } from "@brain/schemas";

export interface WikiEntityRow {
  id: string;
  tenant_id: string;
  kind: string;
  attributes: Record<string, unknown>;
  embedding: number[] | null;
  valid_from: Date;
  valid_to: Date | null;
  provenance: string;
  confidence: number;
  source_evidence: string[];
  superseded_by: string | null;
  supersedes: string | null;
  created_at: Date;
}

export interface InsertEntityInput {
  id: string;
  tenantId: string;
  kind: EntityKind;
  attributes: Record<string, unknown>;
  embedding: number[] | null;
  validFrom: Date;
  validTo: Date | null;
  provenance: Provenance;
  confidence: number;
  sourceEvidence: string[];
  /** When present, this insert closes off the predecessor's valid_to. */
  supersedes?: string;
}

/**
 * §3 Layer 2 governance: agent-contributed rows are capped at 0.5.
 * Promoted rows go through /wiki/annotate or corroboration logic.
 */
function cappedConfidence(provenance: Provenance, raw: number): number {
  if (provenance === "agent_contributed") {
    return Math.min(raw, AGENT_CONTRIBUTED_CONFIDENCE_CEILING);
  }
  return raw;
}

export async function insertEntity(
  client: TenantScopedClient,
  input: InsertEntityInput,
): Promise<WikiEntityRow> {
  const conf = cappedConfidence(input.provenance, input.confidence);

  if (input.supersedes !== undefined) {
    await client.query(
      `UPDATE wiki_entities SET valid_to = $1, superseded_by = $2 WHERE id = $3 AND valid_to IS NULL`,
      [input.validFrom, input.id, input.supersedes],
    );
  }

  const { rows } = await client.query<WikiEntityRow>(
    `INSERT INTO wiki_entities (
       id, tenant_id, kind, attributes, embedding,
       valid_from, valid_to, provenance, confidence, source_evidence, supersedes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.kind,
      JSON.stringify(input.attributes),
      input.embedding === null ? null : vectorLiteral(input.embedding),
      input.validFrom,
      input.validTo,
      input.provenance,
      conf,
      input.sourceEvidence,
      input.supersedes ?? null,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("wiki_entities insert returned no row");
  return row;
}

/**
 * Fetch the entity that was VALID at a given `asOf` timestamp. Returns
 * the currently-valid row when `asOf` is null.
 */
export async function findEntityAsOf(
  client: TenantScopedClient,
  id: string,
  asOf: Date | null,
): Promise<WikiEntityRow | null> {
  if (asOf === null) {
    const { rows } = await client.query<WikiEntityRow>(
      `SELECT * FROM wiki_entities WHERE id = $1 AND valid_to IS NULL LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }
  const { rows } = await client.query<WikiEntityRow>(
    `SELECT * FROM wiki_entities
       WHERE id = $1
         AND valid_from <= $2
         AND (valid_to IS NULL OR valid_to > $2)
       LIMIT 1`,
    [id, asOf],
  );
  return rows[0] ?? null;
}

export async function listEntityVersions(
  client: TenantScopedClient,
  id: string,
): Promise<WikiEntityRow[]> {
  const { rows } = await client.query<WikiEntityRow>(
    `SELECT * FROM wiki_entities WHERE id = $1 OR supersedes = $1 ORDER BY valid_from ASC`,
    [id],
  );
  return rows;
}

export interface SearchFilters {
  kind?: EntityKind;
  q?: string;
  since?: Date;
  until?: Date;
  limit: number;
  cursor?: string | undefined;
}

export async function searchEntities(
  client: TenantScopedClient,
  f: SearchFilters,
): Promise<WikiEntityRow[]> {
  const where: string[] = ["valid_to IS NULL"];
  const values: unknown[] = [];
  if (f.kind !== undefined) {
    values.push(f.kind);
    where.push(`kind = $${values.length}`);
  }
  if (f.since !== undefined) {
    values.push(f.since);
    where.push(`valid_from >= $${values.length}`);
  }
  if (f.until !== undefined) {
    values.push(f.until);
    where.push(`valid_from <= $${values.length}`);
  }
  if (f.q !== undefined && f.q !== "") {
    values.push(`%${f.q}%`);
    where.push(`attributes::text ILIKE $${values.length}`);
  }
  values.push(f.limit);
  const limitClause = `LIMIT $${values.length}`;

  const { rows } = await client.query<WikiEntityRow>(
    `SELECT * FROM wiki_entities WHERE ${where.join(" AND ")}
     ORDER BY valid_from DESC, id DESC ${limitClause}`,
    values,
  );
  return rows;
}

/**
 * Semantic search by embedding cosine distance. `vec` is the caller-supplied
 * query embedding. Returns rows in ascending distance order.
 */
export async function semanticSearch(
  client: TenantScopedClient,
  vec: number[],
  limit: number,
  kind?: EntityKind,
): Promise<WikiEntityRow[]> {
  const values: unknown[] = [vectorLiteral(vec)];
  const extra: string[] = [];
  if (kind !== undefined) {
    values.push(kind);
    extra.push(`AND kind = $${values.length}`);
  }
  values.push(limit);
  const limitIdx = values.length;

  const { rows } = await client.query<WikiEntityRow>(
    `SELECT * FROM wiki_entities
      WHERE valid_to IS NULL AND embedding IS NOT NULL
        ${extra.join(" ")}
      ORDER BY embedding <=> $1::vector
      LIMIT $${limitIdx}`,
    values,
  );
  return rows;
}

/** Serialize a number[] to pgvector's textual form: "[1,2,3]". */
export function vectorLiteral(v: ReadonlyArray<number>): string {
  return `[${v.map((n) => (Number.isFinite(n) ? n.toString() : "0")).join(",")}]`;
}
