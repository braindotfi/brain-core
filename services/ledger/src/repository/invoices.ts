import type { KeysetCursor, TenantScopedClient } from "@brain/shared";
import type { LedgerRowCommon } from "./types.js";

export interface InvoiceRow extends LedgerRowCommon {
  invoice_number: string;
  counterparty_id: string;
  counterparty_name: string | null;
  amount_due: string;
  amount_paid: string;
  currency: string;
  issue_date: Date;
  due_date: Date | null;
  status: string;
  linked_document_ids: string[];
  linked_transaction_ids: string[];
  metadata: Record<string, unknown>;
}

export async function findInvoiceById(
  client: TenantScopedClient,
  id: string,
): Promise<InvoiceRow | null> {
  const { rows } = await client.query<InvoiceRow>(
    `SELECT li.*, cp.name AS counterparty_name
       FROM ledger_invoices li
       LEFT JOIN ledger_counterparties cp
         ON cp.id = li.counterparty_id
        AND cp.owner_id = li.owner_id
      WHERE li.id = $1 AND li.owner_id = current_setting('app.tenant_id', true)
      LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listInvoices(
  client: TenantScopedClient,
  filters: { status?: string; counterparty_id?: string; limit: number; cursor?: KeysetCursor },
): Promise<InvoiceRow[]> {
  const where: string[] = [`li.owner_id = current_setting('app.tenant_id', true)`];
  const values: unknown[] = [];
  if (filters.status !== undefined) {
    values.push(filters.status);
    where.push(`li.status = $${values.length}`);
  }
  if (filters.counterparty_id !== undefined) {
    values.push(filters.counterparty_id);
    where.push(`li.counterparty_id = $${values.length}`);
  }
  if (filters.cursor !== undefined) {
    values.push(filters.cursor.sort, filters.cursor.id);
    const sortIdx = values.length - 1;
    const idIdx = values.length;
    where.push(
      `(li.issue_date < $${sortIdx}::timestamptz OR (li.issue_date = $${sortIdx}::timestamptz AND li.id < $${idIdx}))`,
    );
  }
  values.push(filters.limit);
  const limitIdx = values.length;
  const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const { rows } = await client.query<InvoiceRow>(
    `SELECT li.*, cp.name AS counterparty_name
       FROM ledger_invoices li
       LEFT JOIN ledger_counterparties cp
         ON cp.id = li.counterparty_id
        AND cp.owner_id = li.owner_id
       ${whereSql}
     ORDER BY li.issue_date DESC, li.id DESC
     LIMIT $${limitIdx}`,
    values,
  );
  return rows;
}
