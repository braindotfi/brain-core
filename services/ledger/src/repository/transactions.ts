import type { KeysetCursor, TenantScopedClient } from "@brain/shared";
import type { LedgerRowCommon } from "./types.js";

export interface TransactionRow extends LedgerRowCommon {
  account_id: string;
  external_transaction_id: string | null;
  amount: string;
  currency: string;
  direction: string;
  transaction_date: Date;
  posted_date: Date | null;
  counterparty_id: string | null;
  category_id: string | null;
  status: string;
  description_raw: string | null;
  description_normalized: string | null;
  reconciliation_status: string | null;
  /** On-chain settlement tx hash (0x…64 hex); null for off-chain txs (RFC 0001). */
  chain_tx_hash: string | null;
}

export interface TransactionListFilters {
  account_id?: string;
  counterparty_id?: string;
  direction?: string;
  status?: string;
  since?: Date;
  until?: Date;
  limit: number;
  cursor?: KeysetCursor;
}

export async function findTransactionById(
  client: TenantScopedClient,
  id: string,
): Promise<TransactionRow | null> {
  const { rows } = await client.query<TransactionRow>(
    `SELECT * FROM ledger_transactions
      WHERE id = $1 AND owner_id = current_setting('app.tenant_id', true)
      LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listTransactions(
  client: TenantScopedClient,
  filters: TransactionListFilters,
): Promise<TransactionRow[]> {
  const where: string[] = [`owner_id = current_setting('app.tenant_id', true)`];
  const values: unknown[] = [];
  const push = (sqlFragment: string, v: unknown): void => {
    values.push(v);
    where.push(sqlFragment.replace("$?", `$${values.length}`));
  };
  if (filters.account_id !== undefined) push("account_id = $?", filters.account_id);
  if (filters.counterparty_id !== undefined) push("counterparty_id = $?", filters.counterparty_id);
  if (filters.direction !== undefined) push("direction = $?", filters.direction);
  if (filters.status !== undefined) push("status = $?", filters.status);
  if (filters.since !== undefined) push("transaction_date >= $?", filters.since);
  if (filters.until !== undefined) push("transaction_date <= $?", filters.until);
  if (filters.cursor !== undefined) {
    values.push(filters.cursor.sort, filters.cursor.id);
    const sortIdx = values.length - 1;
    const idIdx = values.length;
    where.push(
      `(transaction_date < $${sortIdx}::timestamptz OR (transaction_date = $${sortIdx}::timestamptz AND id < $${idIdx}))`,
    );
  }

  values.push(filters.limit);
  const limitIdx = values.length;
  const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const { rows } = await client.query<TransactionRow>(
    `SELECT * FROM ledger_transactions ${whereSql}
     ORDER BY transaction_date DESC, id DESC
     LIMIT $${limitIdx}`,
    values,
  );
  return rows;
}
