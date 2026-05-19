import type { TenantScopedClient } from "@brain/api/shared";
import type { LedgerRowCommon } from "./types.js";

export interface CounterpartyRow extends LedgerRowCommon {
  name: string;
  normalized_name: string | null;
  type: string;
  risk_level: string | null;
  verified_status: string | null;
  aliases: string[];
  linked_accounts: string[];
}

export interface CounterpartyListFilters {
  q?: string;
  type?: string;
  verified_status?: string;
  limit: number;
}

export async function findCounterpartyById(
  client: TenantScopedClient,
  id: string,
): Promise<CounterpartyRow | null> {
  const { rows } = await client.query<CounterpartyRow>(
    `SELECT * FROM ledger_counterparties WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listCounterparties(
  client: TenantScopedClient,
  filters: CounterpartyListFilters,
): Promise<CounterpartyRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.type !== undefined) {
    values.push(filters.type);
    where.push(`type = $${values.length}`);
  }
  if (filters.verified_status !== undefined) {
    values.push(filters.verified_status);
    where.push(`verified_status = $${values.length}`);
  }
  if (filters.q !== undefined && filters.q !== "") {
    values.push(`%${filters.q.toLowerCase()}%`);
    where.push(
      `(LOWER(name) LIKE $${values.length} OR LOWER(COALESCE(normalized_name, '')) LIKE $${values.length})`,
    );
  }
  values.push(filters.limit);
  const limitIdx = values.length;
  const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const { rows } = await client.query<CounterpartyRow>(
    `SELECT * FROM ledger_counterparties ${whereSql}
     ORDER BY name ASC
     LIMIT $${limitIdx}`,
    values,
  );
  return rows;
}
