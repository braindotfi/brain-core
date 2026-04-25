import type { TenantScopedClient } from "@brain/api/shared";

export interface TransferRow {
  id: string;
  owner_id: string;
  from_account_id: string;
  to_account_id: string;
  from_transaction_id: string | null;
  to_transaction_id: string | null;
  amount: string;
  currency: string;
  transfer_date: Date;
  status: string;
  source_ids: string[];
  evidence_ids: string[];
  created_at: Date;
  updated_at: Date;
}

export async function findTransferById(
  client: TenantScopedClient,
  id: string,
): Promise<TransferRow | null> {
  const { rows } = await client.query<TransferRow>(
    `SELECT * FROM ledger_transfers WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listTransfers(
  client: TenantScopedClient,
  filters: { account_id?: string; status?: string; limit: number },
): Promise<TransferRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.account_id !== undefined) {
    values.push(filters.account_id);
    where.push(`(from_account_id = $${values.length} OR to_account_id = $${values.length})`);
  }
  if (filters.status !== undefined) {
    values.push(filters.status);
    where.push(`status = $${values.length}`);
  }
  values.push(filters.limit);
  const limitIdx = values.length;
  const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const { rows } = await client.query<TransferRow>(
    `SELECT * FROM ledger_transfers ${whereSql}
     ORDER BY transfer_date DESC
     LIMIT $${limitIdx}`,
    values,
  );
  return rows;
}
