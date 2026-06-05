import type { TenantScopedClient } from "@brain/shared";
import type { LedgerRowCommon } from "./types.js";

export interface ObligationRow extends LedgerRowCommon {
  type: string;
  counterparty_id: string;
  amount_due: string;
  minimum_due: string | null;
  currency: string;
  due_date: Date;
  recurrence: string | null;
  status: string;
  linked_transaction_ids: string[];
  /**
   * payable = we owe the counterparty (vendor side).
   * receivable = the counterparty owes us (customer side).
   * NULL for older rows whose backfill couldn't infer a direction; the §6
   * gate treats NULL as "direction unknown" rather than guessing.
   */
  direction: "payable" | "receivable" | null;
}

export interface ObligationListFilters {
  status?: string;
  type?: string;
  due_before?: Date;
  limit: number;
}

export async function findObligationById(
  client: TenantScopedClient,
  id: string,
): Promise<ObligationRow | null> {
  const { rows } = await client.query<ObligationRow>(
    `SELECT * FROM ledger_obligations WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listObligations(
  client: TenantScopedClient,
  filters: ObligationListFilters,
): Promise<ObligationRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.status !== undefined) {
    values.push(filters.status);
    where.push(`status = $${values.length}`);
  }
  if (filters.type !== undefined) {
    values.push(filters.type);
    where.push(`type = $${values.length}`);
  }
  if (filters.due_before !== undefined) {
    values.push(filters.due_before);
    where.push(`due_date <= $${values.length}`);
  }
  values.push(filters.limit);
  const limitIdx = values.length;
  const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const { rows } = await client.query<ObligationRow>(
    `SELECT * FROM ledger_obligations ${whereSql}
     ORDER BY due_date ASC, id ASC
     LIMIT $${limitIdx}`,
    values,
  );
  return rows;
}
