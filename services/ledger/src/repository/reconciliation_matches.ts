import type { TenantScopedClient } from "@brain/shared";

export interface ReconciliationMatchRow {
  id: string;
  owner_id: string;
  match_type: string;
  left_entity_type: string;
  left_entity_id: string;
  right_entity_type: string;
  right_entity_id: string;
  confidence_score: number;
  status: string;
  evidence_ids: string[];
  explanation: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function findReconciliationMatchById(
  client: TenantScopedClient,
  id: string,
): Promise<ReconciliationMatchRow | null> {
  const { rows } = await client.query<ReconciliationMatchRow>(
    `SELECT * FROM ledger_reconciliation_matches WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listReconciliationMatches(
  client: TenantScopedClient,
  filters: { status?: string; match_type?: string; limit: number },
): Promise<ReconciliationMatchRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.status !== undefined) {
    values.push(filters.status);
    where.push(`status = $${values.length}`);
  }
  if (filters.match_type !== undefined) {
    values.push(filters.match_type);
    where.push(`match_type = $${values.length}`);
  }
  values.push(filters.limit);
  const limitIdx = values.length;
  const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const { rows } = await client.query<ReconciliationMatchRow>(
    `SELECT * FROM ledger_reconciliation_matches ${whereSql}
     ORDER BY created_at DESC
     LIMIT $${limitIdx}`,
    values,
  );
  return rows;
}
