import type { TenantScopedClient } from "@brain/shared";

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

// ---------------------------------------------------------------------------
// Phase-4 write helpers. Called by services/execution/src/payment-intents.
// services/ledger keeps the SQL surface for the table — every PaymentIntent
// mutation goes through one of these helpers so we have a single audit
// surface to instrument and so the service-extraction option is preserved.
// ---------------------------------------------------------------------------

export interface InsertPaymentIntentInput {
  id: string;
  ownerId: string;
  createdByAgentId: string | null;
  actionType: string;
  sourceAccountId: string;
  destinationCounterpartyId: string;
  amount: string;
  currency: string;
  obligationId?: string;
  invoiceId?: string;
  status: string;
  policyDecisionId: string | null;
  evidenceIds: string[];
}

export async function insertPaymentIntent(
  client: TenantScopedClient,
  input: InsertPaymentIntentInput,
): Promise<PaymentIntentRow> {
  const { rows } = await client.query<PaymentIntentRow>(
    `INSERT INTO ledger_payment_intents (
       id, owner_id, created_by_agent_id, action_type,
       source_account_id, destination_counterparty_id,
       amount, currency, obligation_id, invoice_id,
       status, policy_decision_id, evidence_ids,
       provenance, confidence
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'inferred',1.0)
     RETURNING *`,
    [
      input.id,
      input.ownerId,
      input.createdByAgentId,
      input.actionType,
      input.sourceAccountId,
      input.destinationCounterpartyId,
      input.amount,
      input.currency,
      input.obligationId ?? null,
      input.invoiceId ?? null,
      input.status,
      input.policyDecisionId,
      input.evidenceIds,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("payment_intents insert returned no row");
  return row;
}

/**
 * Transition the row's status. Returns the updated row only when the
 * `from` state matched; otherwise null. State-machine validity is the
 * caller's responsibility; this function enforces atomicity.
 */
export async function transitionPaymentIntent(
  client: TenantScopedClient,
  id: string,
  from: string,
  to: string,
): Promise<PaymentIntentRow | null> {
  const { rows } = await client.query<PaymentIntentRow>(
    `UPDATE ledger_payment_intents
        SET status = $1, updated_at = now()
      WHERE id = $2 AND status = $3
      RETURNING *`,
    [to, id, from],
  );
  return rows[0] ?? null;
}

export async function appendApprovalId(
  client: TenantScopedClient,
  id: string,
  approvalId: string,
): Promise<PaymentIntentRow | null> {
  const { rows } = await client.query<PaymentIntentRow>(
    `UPDATE ledger_payment_intents
        SET approval_ids = array_append(approval_ids, $1),
            updated_at = now()
      WHERE id = $2 AND NOT ($1 = ANY (approval_ids))
      RETURNING *`,
    [approvalId, id],
  );
  return rows[0] ?? null;
}

export async function appendExecutionReceiptId(
  client: TenantScopedClient,
  id: string,
  executionId: string,
): Promise<void> {
  await client.query(
    `UPDATE ledger_payment_intents
        SET execution_receipt_ids = array_append(execution_receipt_ids, $1),
            updated_at = now()
      WHERE id = $2`,
    [executionId, id],
  );
}
