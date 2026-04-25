import type { TenantScopedClient } from "@brain/api/shared";

export interface PaymentIntentRow {
  id: string;
  owner_id: string;
  created_by_agent_id: string | null;
  action_type: string;
  source_account_id: string;
  destination_counterparty_id: string;
  amount: string;
  currency: string;
  obligation_id: string | null;
  invoice_id: string | null;
  status: string;
  policy_decision_id: string | null;
  approval_ids: string[];
  execution_receipt_ids: string[];
  source_ids: string[];
  evidence_ids: string[];
  provenance: string;
  confidence: number;
  created_at: Date;
  updated_at: Date;
}

export async function findPaymentIntentById(
  client: TenantScopedClient,
  id: string,
): Promise<PaymentIntentRow | null> {
  const { rows } = await client.query<PaymentIntentRow>(
    `SELECT * FROM ledger_payment_intents WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listPaymentIntents(
  client: TenantScopedClient,
  filters: { status?: string; created_by_agent_id?: string; limit: number },
): Promise<PaymentIntentRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.status !== undefined) {
    values.push(filters.status);
    where.push(`status = $${values.length}`);
  }
  if (filters.created_by_agent_id !== undefined) {
    values.push(filters.created_by_agent_id);
    where.push(`created_by_agent_id = $${values.length}`);
  }
  values.push(filters.limit);
  const limitIdx = values.length;
  const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const { rows } = await client.query<PaymentIntentRow>(
    `SELECT * FROM ledger_payment_intents ${whereSql}
     ORDER BY created_at DESC
     LIMIT $${limitIdx}`,
    values,
  );
  return rows;
}
