/**
 * Governed read API over canonical journal entries (Phase 6, finish reads).
 *
 * The double-entry companion to query/gl-accounts.ts and query/obligations.ts:
 * returns a journal entry as a governed data product -- the header + its
 * debit/credit lines, plus provenance and freshness. Completes the accounting
 * domain's read surface (gl accounts + obligations already shipped). Read-only,
 * tenant-scoped.
 */

import { withTenantScope, type ServiceCallContext, type TenantScopedClient } from "@brain/shared";
import type { Pool } from "pg";

export interface JournalLineView {
  line_number: number;
  gl_account_id: string | null;
  gl_account_key: string | null;
  direction: string;
  amount: string;
  currency: string | null;
  description: string | null;
}

export interface JournalEntryProduct {
  domain: "accounting";
  record: {
    id: string;
    posted_at: string | null;
    memo: string | null;
    currency: string | null;
    status: string | null;
    source_system: string;
    source_natural_key: string;
    lines: JournalLineView[];
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

interface JournalEntryProductRow {
  id: string;
  posted_at: Date | null;
  memo: string | null;
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
  lines: JournalLineView[];
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** Pure: shape a joined row (header + aggregated lines) into the governed envelope. */
export function toJournalEntryProduct(row: JournalEntryProductRow): JournalEntryProduct {
  return {
    domain: "accounting",
    record: {
      id: row.id,
      posted_at: iso(row.posted_at),
      memo: row.memo,
      currency: row.currency,
      status: row.status,
      source_system: row.source_system,
      source_natural_key: row.source_natural_key,
      lines: row.lines,
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
  SELECT je.id, je.posted_at, je.memo, je.currency, je.status, je.source_system,
         je.source_natural_key, je.schema_version, je.provenance, je.confidence,
         je.source_ids, je.evidence_ids, COALESCE(je.extensions, '{}'::jsonb) AS extensions,
         je.updated_at, pl.projected_at, pl.projector,
         COALESCE(lines.arr, '[]'::json) AS lines
    FROM canonical_journal_entry je
    LEFT JOIN LATERAL (
      SELECT projected_at, projector FROM canonical_projection_log
       WHERE raw_parsed_id = ANY(je.evidence_ids)
       ORDER BY projected_at DESC LIMIT 1
    ) pl ON true
    LEFT JOIN LATERAL (
      SELECT json_agg(
               json_build_object(
                 'line_number', l.line_number, 'gl_account_id', l.gl_account_id,
                 'gl_account_key', l.gl_account_key, 'direction', l.direction,
                 'amount', l.amount::text, 'currency', l.currency, 'description', l.description
               ) ORDER BY l.line_number
             ) AS arr
        FROM canonical_journal_line l WHERE l.journal_entry_id = je.id
    ) lines ON true`;

export async function getJournalEntryProduct(
  pool: Pool,
  ctx: ServiceCallContext,
  id: string,
): Promise<JournalEntryProduct | null> {
  return withTenantScope(pool, ctx.tenantId, async (c: TenantScopedClient) => {
    const { rows } = await c.query<JournalEntryProductRow>(`${SELECT_PRODUCT} WHERE je.id = $1`, [
      id,
    ]);
    const row = rows[0];
    return row === undefined ? null : toJournalEntryProduct(row);
  });
}

export async function listJournalEntryProducts(
  pool: Pool,
  ctx: ServiceCallContext,
  limit: number,
): Promise<JournalEntryProduct[]> {
  return withTenantScope(pool, ctx.tenantId, async (c: TenantScopedClient) => {
    const { rows } = await c.query<JournalEntryProductRow>(
      `${SELECT_PRODUCT} ORDER BY je.posted_at DESC NULLS LAST, je.id LIMIT $1`,
      [limit],
    );
    return rows.map(toJournalEntryProduct);
  });
}
