/**
 * H-22 duplicate-payment detector. Backs §6 gate check 11.5.
 *
 * "Brain will not pay an invoice twice" as a deterministic gate property. Each
 * rule is a tenant-scoped query; ANY collision fails the gate (hard reject, even
 * with approval). Queries do NOT filter by tenant_id in WHERE; tenant isolation
 * is enforced by RLS via the TenantScopedClient (Standards §1.2).
 *
 * The gate consumes this through the injected `detectDuplicates` hook; the call
 * site wraps it in withTenantScope(pool, ctx.tenantId, ...).
 *
 * Schema sources:
 *   - rules 1, 2, 3, 4 → migration 0010 + 0018 (ledger_payment_intents, indexes)
 *   - rule 5           → migration 0010 (evidence_ids text[] column)
 *   - rule 6           → migration 0026 (ledger_counterparty_payment_instructions)
 *                        populated by migration 0027 (Postgres AFTER UPDATE
 *                        trigger on linked_accounts / onchain_address).
 *   - rule 7           → migration 0034 (ledger_reconciliation_matches)
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

    // 7 — reconciliation_obligation_duplicate_paid. Follow the confirmed
    // obligation_duplicate graph so cross-source observations of the same bill
    // cannot be paid independently just because they use different
    // counterparty rows or obligation ids.
    const { rows: linked } = await client.query<{
      obligation_id: string;
      status: string | null;
      payment_intent_id: string | null;
    }>(
      `WITH RECURSIVE linked_obligations(id) AS (
          SELECT $1::text
          UNION
          SELECT CASE
                   WHEN m.left_entity_id = linked_obligations.id THEN m.right_entity_id
                   ELSE m.left_entity_id
                 END
            FROM ledger_reconciliation_matches m
            JOIN linked_obligations
              ON m.left_entity_id = linked_obligations.id
              OR m.right_entity_id = linked_obligations.id
           WHERE m.match_type = 'obligation_duplicate'
             AND m.status = 'matched'
             AND m.left_entity_type = 'obligation'
             AND m.right_entity_type = 'obligation'
        )
        SELECT l.id AS obligation_id, o.status, pi2.id AS payment_intent_id
          FROM linked_obligations l
          LEFT JOIN ledger_obligations o ON o.id = l.id
          LEFT JOIN ledger_payment_intents pi2
            ON pi2.obligation_id = l.id
           AND pi2.status = 'executed'
           AND pi2.id <> $2
         WHERE l.id <> $1
           AND (o.status = 'paid' OR pi2.id IS NOT NULL)
         LIMIT 1`,
      [pi.obligationId, pi.id],
    );
    if (linked[0] !== undefined) {
      collisions.push({
        rule: "reconciliation_obligation_duplicate_paid",
        detail: `linked duplicate obligation ${linked[0].obligation_id} is already paid`,
        ...(linked[0].payment_intent_id !== null
          ? { conflicting_payment_intent_id: linked[0].payment_intent_id }
          : {}),
      });
    }
  }

  // 3 — vendor_amount_invoice_match (last 30 days). updated_at is the execution
  // time for an executed row (there is no executed_at column).
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

  // 5 — raw_invoice_used_elsewhere. PI↔raw link is the evidence_ids text[]
  // column on ledger_payment_intents (migration 0010).
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
  // swap). Reads the append-only payment-instruction history populated by the
  // trigger in migration 0027 (writer fires AFTER UPDATE OF linked_accounts,
  // onchain_address on ledger_counterparties).
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
