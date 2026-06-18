/**
 * Governed read API over the canonical chart of accounts (Phase 6 PR-3).
 *
 * The accounting-domain companion to query/obligations.ts: returns a canonical
 * GL account as a governed data product -- the record plus its provenance and
 * freshness. Read-only, tenant-scoped. Completes the accounting domain's read
 * surface (obligations shipped in PR-1).
 */

import { withTenantScope, type ServiceCallContext, type TenantScopedClient } from "@brain/shared";
import type { Pool } from "pg";

export interface GlAccountProduct {
  domain: "accounting";
  record: {
    id: string;
    name: string;
    classification: string;
    account_number: string | null;
    currency: string | null;
    status: string | null;
    source_system: string;
    source_natural_key: string;
    extensions: Record<string, unknown>;
  };
  provenance: {
    provenance: string;
    confidence: number | null;
    source_ids: string[];
    evidence_ids: string[];
  };
  freshness: {
    schema_version: number;
    source_system: string;
    updated_at: string;
    projected_at: string | null;
    projector: string | null;
  };
}

interface GlAccountProductRow {
  id: string;
  name: string;
  classification: string;
  account_number: string | null;
  currency: string | null;
  status: string | null;
  source_system: string;
  source_natural_key: string;
  schema_version: number;
  provenance: string;
  confidence: number | null;
  source_ids: string[];
  evidence_ids: string[];
  extensions: Record<string, unknown>;
  updated_at: Date;
  projected_at: Date | null;
  projector: string | null;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** Pure: shape a joined row into the governed data-product envelope. */
export function toGlAccountProduct(row: GlAccountProductRow): GlAccountProduct {
  return {
    domain: "accounting",
    record: {
      id: row.id,
      name: row.name,
      classification: row.classification,
      account_number: row.account_number,
      currency: row.currency,
      status: row.status,
      source_system: row.source_system,
      source_natural_key: row.source_natural_key,
      extensions: row.extensions,
    },
    provenance: {
      provenance: row.provenance,
      confidence: row.confidence,
      source_ids: row.source_ids,
      evidence_ids: row.evidence_ids,
    },
    freshness: {
      schema_version: row.schema_version,
      source_system: row.source_system,
      updated_at: row.updated_at.toISOString(),
      projected_at: iso(row.projected_at),
      projector: row.projector,
    },
  };
}

const SELECT_PRODUCT = `
  SELECT g.id, g.name, g.classification, g.account_number, g.currency, g.status,
         g.source_system, g.source_natural_key, g.schema_version, g.provenance, g.confidence,
         g.source_ids, g.evidence_ids, COALESCE(g.extensions, '{}'::jsonb) AS extensions,
         g.updated_at, pl.projected_at, pl.projector
    FROM canonical_gl_account g
    LEFT JOIN LATERAL (
      SELECT projected_at, projector FROM canonical_projection_log
       WHERE raw_parsed_id = ANY(g.evidence_ids)
       ORDER BY projected_at DESC LIMIT 1
    ) pl ON true`;

export interface ListGlAccountsFilter {
  classification?: string;
  limit: number;
}

export async function getGlAccountProduct(
  pool: Pool,
  ctx: ServiceCallContext,
  id: string,
): Promise<GlAccountProduct | null> {
  return withTenantScope(pool, ctx.tenantId, async (c: TenantScopedClient) => {
    const { rows } = await c.query<GlAccountProductRow>(`${SELECT_PRODUCT} WHERE g.id = $1`, [id]);
    const row = rows[0];
    return row === undefined ? null : toGlAccountProduct(row);
  });
}

export async function listGlAccountProducts(
  pool: Pool,
  ctx: ServiceCallContext,
  filter: ListGlAccountsFilter,
): Promise<GlAccountProduct[]> {
  return withTenantScope(pool, ctx.tenantId, async (c: TenantScopedClient) => {
    const { rows } = await c.query<GlAccountProductRow>(
      `${SELECT_PRODUCT}
        WHERE ($1::text IS NULL OR g.classification = $1)
        ORDER BY g.account_number ASC NULLS LAST, g.name ASC
        LIMIT $2`,
      [filter.classification ?? null, filter.limit],
    );
    return rows.map(toGlAccountProduct);
  });
}
