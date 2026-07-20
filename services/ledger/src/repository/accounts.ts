import type { KeysetCursor, TenantScopedClient } from "@brain/shared";
import type { LedgerRowCommon } from "./types.js";

export interface AccountRow extends LedgerRowCommon {
  institution: string | null;
  external_account_id: string | null;
  account_type: string;
  name: string;
  currency: string;
  current_balance: string | null;
  available_balance: string | null;
  status: string;
}

export interface AccountListFilters {
  status?: string;
  account_type?: string;
  limit: number;
  cursor?: KeysetCursor;
}

export async function findAccountById(
  client: TenantScopedClient,
  id: string,
): Promise<AccountRow | null> {
  const { rows } = await client.query<AccountRow>(
    `SELECT * FROM ledger_accounts
      WHERE id = $1 AND owner_id = current_setting('app.tenant_id', true)
      LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listAccounts(
  client: TenantScopedClient,
  filters: AccountListFilters,
): Promise<AccountRow[]> {
  const where: string[] = [`owner_id = current_setting('app.tenant_id', true)`];
  const values: unknown[] = [];
  if (filters.status !== undefined) {
    values.push(filters.status);
    where.push(`status = $${values.length}`);
  }
  if (filters.account_type !== undefined) {
    values.push(filters.account_type);
    where.push(`account_type = $${values.length}`);
  }
  if (filters.cursor !== undefined) {
    values.push(filters.cursor.sort, filters.cursor.id);
    const sortIdx = values.length - 1;
    const idIdx = values.length;
    where.push(
      `(created_at < $${sortIdx}::timestamptz OR (created_at = $${sortIdx}::timestamptz AND id < $${idIdx}))`,
    );
  }
  values.push(filters.limit);
  const limitIdx = values.length;
  const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const { rows } = await client.query<AccountRow>(
    `SELECT * FROM ledger_accounts ${whereSql}
     ORDER BY created_at DESC, id DESC
     LIMIT $${limitIdx}`,
    values,
  );
  return rows;
}
