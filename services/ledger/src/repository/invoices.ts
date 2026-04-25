import type { TenantScopedClient } from "@brain/api/shared";
import type { LedgerRowCommon } from "./types.js";

export interface InvoiceRow extends LedgerRowCommon {
  invoice_number: string;
  counterparty_id: string;
  amount_due: string;
  amount_paid: string;
  currency: string;
  issue_date: Date;
  due_date: Date | null;
  status: string;
  linked_document_ids: string[];
  linked_transaction_ids: string[];
}

export async function findInvoiceById(
  client: TenantScopedClient,
  id: string,
): Promise<InvoiceRow | null> {
  const { rows } = await client.query<InvoiceRow>(
    `SELECT * FROM ledger_invoices WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listInvoices(
  client: TenantScopedClient,
  filters: { status?: string; counterparty_id?: string; limit: number },
): Promise<InvoiceRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.status !== undefined) {
    values.push(filters.status);
    where.push(`status = $${values.length}`);
  }
  if (filters.counterparty_id !== undefined) {
    values.push(filters.counterparty_id);
    where.push(`counterparty_id = $${values.length}`);
  }
  values.push(filters.limit);
  const limitIdx = values.length;
  const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const { rows } = await client.query<InvoiceRow>(
    `SELECT * FROM ledger_invoices ${whereSql}
     ORDER BY issue_date DESC
     LIMIT $${limitIdx}`,
    values,
  );
  return rows;
}
