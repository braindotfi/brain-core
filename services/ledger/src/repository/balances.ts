import type { TenantScopedClient } from "@brain/shared";
import type { LedgerRowCommon } from "./types.js";

export interface BalanceRow extends LedgerRowCommon {
  account_id: string;
  as_of: Date;
  current_balance: string;
  available_balance: string | null;
  pending_balance: string | null;
  currency: string;
}

export async function findLatestBalance(
  client: TenantScopedClient,
  accountId: string,
): Promise<BalanceRow | null> {
  const { rows } = await client.query<BalanceRow>(
    `SELECT * FROM ledger_balances
     WHERE account_id = $1
       AND owner_id = current_setting('app.tenant_id', true)
     ORDER BY as_of DESC
     LIMIT 1`,
    [accountId],
  );
  return rows[0] ?? null;
}

export async function listBalances(
  client: TenantScopedClient,
  filters: { account_id?: string; as_of?: Date },
): Promise<BalanceRow[]> {
  const where: string[] = [`owner_id = current_setting('app.tenant_id', true)`];
  const values: unknown[] = [];
  if (filters.account_id !== undefined) {
    values.push(filters.account_id);
    where.push(`account_id = $${values.length}`);
  }
  if (filters.as_of !== undefined) {
    values.push(filters.as_of);
    where.push(`as_of <= $${values.length}`);
  }
  const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const { rows } = await client.query<BalanceRow>(
    `SELECT * FROM ledger_balances ${whereSql}
     ORDER BY as_of DESC
     LIMIT 200`,
    values,
  );
  return rows;
}
