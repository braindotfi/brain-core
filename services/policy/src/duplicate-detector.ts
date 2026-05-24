/**
 * H-22 duplicate-payment detector — backs §6 gate check 11.5.
 *
 * "Brain will not pay an invoice twice" as a deterministic gate property. Each
 * rule is a tenant-scoped query; ANY collision fails the gate (hard reject, even
 * with approval). Queries do NOT filter by tenant_id in WHERE — tenant isolation
 * is enforced by RLS via the TenantScopedClient (Standards §1.2).
 *
 * The gate consumes this through the injected `detectDuplicates` hook; the call
 * site wraps it in withTenantScope(pool, ctx.tenantId, ...).
 *
 * SANDBOX NOTE: the rule LOGIC (given query results → collisions) is unit-tested
 * with a fake client. The SQL/schema for rules referencing the evidence→invoice
 * join (vendor_amount_invoice_match), the raw-artifact link
 * (raw_invoice_used_elsewhere), and the payment-instruction history
 * (destination_recently_changed) is best-effort and marked TODO(hardening-pass)
 * — it must be run against Postgres to confirm table/column names + the indexes
 * in migration 0XXX_payment_intents_dedup.sql.
 */

import type { TenantScopedClient } from "@brain/shared";
import type { DuplicateCheckInput, DuplicateCheckResult, DuplicateCollision } from "@brain/shared";

export type { DuplicateCheckInput, DuplicateCheckResult } from "@brain/shared";

export async function detectDuplicates(
  client: TenantScopedClient,
  input: DuplicateCheckInput,
): Promise<DuplicateCheckResult> {
  const pi = input.paymentIntent;
  const collisions: DuplicateCollision[] = [];

  // 1 — invoice_already_paid
  if (pi.invoiceId !== undefined) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM ledger_payment_intents
        WHERE invoice_id = $1 AND status = 'executed' AND id <> $2 LIMIT 1`,
      [pi.invoiceId, pi.id],
    );
    if (rows[0] !== undefined) {
      collisions.push({
        rule: "invoice_already_paid",
        detail: `invoice ${pi.invoiceId} already paid`,
        conflicting_payment_intent_id: rows[0].id,
      });
    }
  }

  // 2 — obligation_already_settled
  if (pi.obligationId !== undefined) {
    const { rows: obl } = await client.query<{ status: string }>(
      `SELECT status FROM ledger_obligations WHERE id = $1 LIMIT 1`,
      [pi.obligationId],
    );
    if (obl[0]?.status === "paid") {
      collisions.push({
        rule: "obligation_already_settled",
        detail: `obligation ${pi.obligationId} is already paid`,
      });
    }
    const { rows: ex } = await client.query<{ id: string }>(
      `SELECT id FROM ledger_payment_intents
        WHERE obligation_id = $1 AND status = 'executed' AND id <> $2 LIMIT 1`,
      [pi.obligationId, pi.id],
    );
    if (ex[0] !== undefined) {
      collisions.push({
        rule: "obligation_already_settled",
        detail: `obligation ${pi.obligationId} already has an executed payment`,
        conflicting_payment_intent_id: ex[0].id,
      });
    }
  }

  // 3 — vendor_amount_invoice_match (last 30 days). updated_at is the execution
  // time for an executed row (there is no executed_at column). TODO(hardening-
  // pass): add the invoice_number-from-evidence dimension once the join is wired.
  {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM ledger_payment_intents
        WHERE destination_counterparty_id = $1 AND amount = $2 AND currency = $3
          AND status = 'executed' AND updated_at > now() - interval '30 days'
          AND id <> $4 LIMIT 1`,
      [pi.counterpartyId, pi.amount, pi.currency, pi.id],
    );
    if (rows[0] !== undefined) {
      collisions.push({
        rule: "vendor_amount_invoice_match",
        detail: `same counterparty+amount executed within 30 days`,
        conflicting_payment_intent_id: rows[0].id,
      });
    }
  }

  // 4 — payment_intent_recently_executed (10-minute retry-loop dedup).
  {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM ledger_payment_intents
        WHERE destination_counterparty_id = $1 AND amount = $2 AND currency = $3
          AND status = 'executed' AND updated_at > now() - interval '10 minutes'
          AND id <> $4 LIMIT 1`,
      [pi.counterpartyId, pi.amount, pi.currency, pi.id],
    );
    if (rows[0] !== undefined) {
      collisions.push({
        rule: "payment_intent_recently_executed",
        detail: `same counterparty+amount+currency executed within 10 minutes`,
        conflicting_payment_intent_id: rows[0].id,
      });
    }
  }

  // 5 — raw_invoice_used_elsewhere. TODO(hardening-pass): confirm the PI↔raw
  // artifact link (evidence_ids array / link table) against the schema.
  if (pi.evidenceArtifactIds.length > 0) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM ledger_payment_intents
        WHERE evidence_ids && $1::text[] AND status <> 'cancelled' AND id <> $2 LIMIT 1`,
      [[...pi.evidenceArtifactIds], pi.id],
    );
    if (rows[0] !== undefined) {
      collisions.push({
        rule: "raw_invoice_used_elsewhere",
        detail: `evidence artifact already referenced by another payment intent`,
        conflicting_payment_intent_id: rows[0].id,
      });
    }
  }

  // 6 — destination_recently_changed (strongest fraud signal: vendor account
  // swap). TODO(hardening-pass): confirm the payment-instruction history table.
  {
    const { rows } = await client.query<{ changed_at: Date }>(
      `SELECT changed_at FROM ledger_counterparty_payment_instructions
        WHERE counterparty_id = $1 AND changed_at > now() - interval '24 hours'
        ORDER BY changed_at DESC LIMIT 1`,
      [pi.counterpartyId],
    );
    if (rows[0] !== undefined) {
      collisions.push({
        rule: "destination_recently_changed",
        detail: `counterparty ${pi.counterpartyId} payment instructions changed within 24h`,
      });
    }
  }

  return { passed: collisions.length === 0, collisions };
}
