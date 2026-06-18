/**
 * Governed read API over the canonical AP/AR domain (Phase 6, data products).
 *
 * Returns a canonical obligation as a governed "data product": the record plus
 * its provenance (how Brain knows it -- provenance, confidence, the source
 * artifacts and evidence) and its freshness (when it was last projected, by
 * which projector). This is the provenance-backed "explain this number"
 * surface agents and product services consume; it never exposes a value
 * without the evidence behind it (§1.1 provenance-on-everything).
 *
 * Read-only and tenant-scoped. It exposes canonical's OWN records; the resolved
 * cross-source view (field-level authority + conflicts) is the Ledger's
 * resolveObligationView and is a separate endpoint.
 */

import { withTenantScope, type ServiceCallContext, type TenantScopedClient } from "@brain/shared";
import type { Pool } from "pg";

export interface ObligationProductProvenance {
  provenance: string;
  confidence: number | null;
  source_ids: string[];
  evidence_ids: string[];
}

export interface ObligationProductFreshness {
  schema_version: number;
  source_system: string;
  updated_at: string;
  /** When a projector last consumed the backing evidence; null if unlogged. */
  projected_at: string | null;
  projector: string | null;
}

export interface ObligationProduct {
  domain: "ap_ar";
  record: {
    id: string;
    direction: string;
    type: string;
    canonical_counterparty_id: string | null;
    amount: string;
    currency: string | null;
    issue_date: string | null;
    due_date: string | null;
    status: string | null;
    source_system: string;
    source_natural_key: string;
    extensions: Record<string, unknown>;
  };
  provenance: ObligationProductProvenance;
  freshness: ObligationProductFreshness;
}

interface ObligationProductRow {
  id: string;
  direction: string;
  type: string;
  canonical_counterparty_id: string | null;
  amount: string;
  currency: string | null;
  issue_date: Date | null;
  due_date: Date | null;
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
export function toObligationProduct(row: ObligationProductRow): ObligationProduct {
  return {
    domain: "ap_ar",
    record: {
      id: row.id,
      direction: row.direction,
      type: row.type,
      canonical_counterparty_id: row.canonical_counterparty_id,
      amount: row.amount,
      currency: row.currency,
      issue_date: iso(row.issue_date),
      due_date: iso(row.due_date),
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

// The freshness join: the latest projection-log entry that consumed any of the
// record's backing evidence (raw_parsed) rows.
const SELECT_PRODUCT = `
  SELECT o.id, o.direction, o.type, o.canonical_counterparty_id, o.amount::text AS amount,
         o.currency, o.issue_date, o.due_date, o.status, o.source_system, o.source_natural_key,
         o.schema_version, o.provenance, o.confidence, o.source_ids, o.evidence_ids,
         COALESCE(o.extensions, '{}'::jsonb) AS extensions, o.updated_at,
         pl.projected_at, pl.projector
    FROM canonical_obligation o
    LEFT JOIN LATERAL (
      SELECT projected_at, projector FROM canonical_projection_log
       WHERE raw_parsed_id = ANY(o.evidence_ids)
       ORDER BY projected_at DESC LIMIT 1
    ) pl ON true`;

export interface ListObligationsFilter {
  direction?: "payable" | "receivable";
  limit: number;
}

export async function getObligationProduct(
  pool: Pool,
  ctx: ServiceCallContext,
  id: string,
): Promise<ObligationProduct | null> {
  return withTenantScope(pool, ctx.tenantId, async (c: TenantScopedClient) => {
    const { rows } = await c.query<ObligationProductRow>(`${SELECT_PRODUCT} WHERE o.id = $1`, [id]);
    const row = rows[0];
    return row === undefined ? null : toObligationProduct(row);
  });
}

export async function listObligationProducts(
  pool: Pool,
  ctx: ServiceCallContext,
  filter: ListObligationsFilter,
): Promise<ObligationProduct[]> {
  return withTenantScope(pool, ctx.tenantId, async (c: TenantScopedClient) => {
    const { rows } = await c.query<ObligationProductRow>(
      `${SELECT_PRODUCT}
        WHERE ($1::text IS NULL OR o.direction = $1)
        ORDER BY o.updated_at DESC
        LIMIT $2`,
      [filter.direction ?? null, filter.limit],
    );
    return rows.map(toObligationProduct);
  });
}
