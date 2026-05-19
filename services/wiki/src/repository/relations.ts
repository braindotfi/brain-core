/**
 * wiki_relations repository.
 *
 * Multi-hop neighbor expansion uses a recursive CTE anchored at a
 * starting entity, bounded by max depth. Stage-3 only ships 1-hop for
 * /wiki/entity/{id}; deeper traversal is reserved for /wiki/question.
 */

import type { TenantScopedClient } from "@brain/shared";
import type { Provenance, RelationKind } from "@brain/schemas";

export interface WikiRelationRow {
  id: string;
  tenant_id: string;
  src: string;
  dst: string;
  kind: string;
  attributes: Record<string, unknown>;
  valid_from: Date;
  valid_to: Date | null;
  provenance: string;
  confidence: number;
  source_evidence: string[];
  created_at: Date;
}

export interface InsertRelationInput {
  id: string;
  tenantId: string;
  src: string;
  dst: string;
  kind: RelationKind;
  attributes: Record<string, unknown>;
  validFrom: Date;
  validTo: Date | null;
  provenance: Provenance;
  confidence: number;
  sourceEvidence: string[];
}

export async function insertRelation(
  client: TenantScopedClient,
  input: InsertRelationInput,
): Promise<WikiRelationRow> {
  const { rows } = await client.query<WikiRelationRow>(
    `INSERT INTO wiki_relations (
       id, tenant_id, src, dst, kind, attributes,
       valid_from, valid_to, provenance, confidence, source_evidence
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.src,
      input.dst,
      input.kind,
      JSON.stringify(input.attributes),
      input.validFrom,
      input.validTo,
      input.provenance,
      input.confidence,
      input.sourceEvidence,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("wiki_relations insert returned no row");
  return row;
}

/** 1-hop neighbors in either direction, asOf a given time (or current). */
export async function findOneHopNeighbors(
  client: TenantScopedClient,
  entityId: string,
  asOf: Date | null,
): Promise<WikiRelationRow[]> {
  if (asOf === null) {
    const { rows } = await client.query<WikiRelationRow>(
      `SELECT * FROM wiki_relations
        WHERE (src = $1 OR dst = $1) AND valid_to IS NULL`,
      [entityId],
    );
    return rows;
  }
  const { rows } = await client.query<WikiRelationRow>(
    `SELECT * FROM wiki_relations
      WHERE (src = $1 OR dst = $1)
        AND valid_from <= $2
        AND (valid_to IS NULL OR valid_to > $2)`,
    [entityId, asOf],
  );
  return rows;
}

/**
 * Recursive CTE: expand neighbors out to max_depth. Used by /wiki/question
 * when it needs to walk evidence paths. Returns the relation rows plus
 * their distance (1-indexed) from the start.
 */
export async function expandNeighborhood(
  client: TenantScopedClient,
  startId: string,
  maxDepth: number,
): Promise<Array<WikiRelationRow & { depth: number }>> {
  const { rows } = await client.query<WikiRelationRow & { depth: number }>(
    `WITH RECURSIVE walk AS (
       SELECT r.*, 1 AS depth
         FROM wiki_relations r
        WHERE (r.src = $1 OR r.dst = $1) AND r.valid_to IS NULL
       UNION
       SELECT r.*, w.depth + 1
         FROM wiki_relations r
         JOIN walk w ON (r.src = w.dst OR r.dst = w.src)
        WHERE r.valid_to IS NULL
          AND w.depth < $2
     )
     SELECT DISTINCT ON (id) id, tenant_id, src, dst, kind, attributes,
            valid_from, valid_to, provenance, confidence, source_evidence, created_at, depth
       FROM walk
       ORDER BY id, depth ASC`,
    [startId, maxDepth],
  );
  return rows;
}
