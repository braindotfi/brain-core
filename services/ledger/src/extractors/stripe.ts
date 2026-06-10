/**
 * Stripe extractor — interprets `stripe_v1` raw_parsed rows (Phase 3
 * connector 2, Appendix A).
 *
 * Payload shape (produced by the raw interpretation worker from verbatim
 * Stripe list pages): { object_type, stripe_account_id, objects }.
 *
 * Canonical mapping, chosen to satisfy "payouts and charges land as
 * transactions with correct direction" WITHOUT double-counting against the
 * balance_transactions feed:
 *  - charge   -> transaction, inflow,  external id ch_*  (+ customer counterparty link)
 *  - payout   -> transaction, outflow, external id po_*  (Stripe balance -> bank)
 *  - refund   -> transaction, outflow, external id re_*
 *  - balance_transaction -> transactions for FEE entries only (txn_*); the
 *    money-moving entries are already covered by their source objects above
 *  - customer -> counterparty (type customer)
 *  - dispute  -> obligation (type other, status disputed, direction payable)
 *    against the processor counterparty — the dispute is money potentially
 *    clawed back through Stripe; per-customer attribution needs the charge
 *    join and lands with reconciliation (Phase 4)
 *
 * Every transaction hangs off the connected processor-balance account
 * (external_account_id = the Stripe account id, account_type
 * payment_processor). Structured provider data writes provenance
 * `extracted` (Phase 2 trust mapping); idempotency rides the
 * (account, external_transaction_id) dedup key with Stripe object ids.
 */

import type { Pool } from "pg";
import { brainError, type AuditEmitter, type ServiceCallContext } from "@brain/shared";
import {
  recordTransactionRow,
  upsertAccountRow,
  upsertCounterpartyRow,
  upsertObligationRow,
} from "../service/writes.js";
import type { ExtractedRow, ParserExtractInput } from "./registry.js";

interface StripeObject {
  id?: string;
  object?: string;
  amount?: number;
  currency?: string;
  created?: number;
  status?: string;
  type?: string;
  description?: string | null;
  customer?: string | null;
  name?: string | null;
  email?: string | null;
  fee?: number;
  evidence_details?: { due_by?: number | null };
}

const ACCOUNT_CONFIDENCE = 0.95;
const TRANSACTION_CONFIDENCE = 0.9;
const COUNTERPARTY_CONFIDENCE = 0.7;
const OBLIGATION_CONFIDENCE = 0.8;

/** Integer minor units -> exact decimal string (no f64). */
export function centsToDecimal(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw brainError("ledger_row_invalid", `stripe amount is not integer minor units: ${cents}`);
  }
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100).toString();
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${whole}.${frac}`;
}

function isoFromEpoch(seconds: number | undefined): string {
  return new Date((seconds ?? 0) * 1000).toISOString();
}

function currencyOf(o: StripeObject): string {
  return (o.currency ?? "usd").toUpperCase();
}

type TxStatus = "pending" | "posted" | "cleared" | "failed" | "reversed" | "disputed";

function chargeStatus(s: string | undefined): TxStatus {
  if (s === "succeeded") return "posted";
  if (s === "failed") return "failed";
  return "pending";
}

function payoutStatus(s: string | undefined): TxStatus {
  if (s === "paid") return "posted";
  if (s === "failed" || s === "canceled") return "failed";
  return "pending";
}

export async function normalizeStripeArtifact(
  pool: Pool,
  audit: AuditEmitter,
  ctx: ServiceCallContext,
  input: ParserExtractInput,
): Promise<ExtractedRow[]> {
  const objectType = input.payload["object_type"];
  const stripeAccountId = input.payload["stripe_account_id"];
  const objects = input.payload["objects"];
  if (typeof objectType !== "string" || !Array.isArray(objects)) {
    throw brainError("ledger_row_invalid", "stripe_v1: payload must carry object_type + objects");
  }
  if (typeof stripeAccountId !== "string" || stripeAccountId.length === 0) {
    throw brainError("ledger_row_invalid", "stripe_v1: payload missing stripe_account_id");
  }

  const created: ExtractedRow[] = [];
  const sourceIds = [input.rawArtifactId];
  const evidenceIds = [input.rawParsedId];
  const common = {
    source_ids: sourceIds,
    evidence_ids: evidenceIds,
    provenance: "extracted",
  };

  const needsAccount =
    objectType === "charge" ||
    objectType === "payout" ||
    objectType === "refund" ||
    objectType === "balance_transaction";

  let accountId: string | null = null;
  if (needsAccount) {
    const first = (objects[0] ?? {}) as StripeObject;
    const { row } = await upsertAccountRow(pool, audit, ctx, {
      external_account_id: stripeAccountId,
      institution: "Stripe",
      account_type: "payment_processor",
      name: "Stripe Balance",
      currency: currencyOf(first),
      status: "active",
      ...common,
      confidence: ACCOUNT_CONFIDENCE,
    });
    accountId = row.id;
    created.push({ entity: "account", id: row.id });
  }

  for (const raw of objects) {
    const o = raw as StripeObject;
    if (typeof o.id !== "string" || o.id.length === 0) continue;

    if (objectType === "charge" && accountId !== null) {
      const { row } = await recordTransactionRow(pool, audit, ctx, {
        account_id: accountId,
        external_transaction_id: o.id,
        amount: centsToDecimal(o.amount ?? 0),
        currency: currencyOf(o),
        direction: "inflow",
        transaction_date: isoFromEpoch(o.created),
        status: chargeStatus(o.status),
        ...(typeof o.description === "string" ? { description_raw: o.description } : {}),
        ...common,
        confidence: TRANSACTION_CONFIDENCE,
      });
      created.push({ entity: "transaction", id: row.id });
      continue;
    }

    if (objectType === "payout" && accountId !== null) {
      const { row } = await recordTransactionRow(pool, audit, ctx, {
        account_id: accountId,
        external_transaction_id: o.id,
        amount: centsToDecimal(o.amount ?? 0),
        currency: currencyOf(o),
        direction: "outflow",
        transaction_date: isoFromEpoch(o.created),
        status: payoutStatus(o.status),
        description_raw: "Stripe payout",
        ...common,
        confidence: TRANSACTION_CONFIDENCE,
      });
      created.push({ entity: "transaction", id: row.id });
      continue;
    }

    if (objectType === "refund" && accountId !== null) {
      const { row } = await recordTransactionRow(pool, audit, ctx, {
        account_id: accountId,
        external_transaction_id: o.id,
        amount: centsToDecimal(o.amount ?? 0),
        currency: currencyOf(o),
        direction: "outflow",
        transaction_date: isoFromEpoch(o.created),
        status: chargeStatus(o.status),
        description_raw: "Stripe refund",
        ...common,
        confidence: TRANSACTION_CONFIDENCE,
      });
      created.push({ entity: "transaction", id: row.id });
      continue;
    }

    if (objectType === "balance_transaction" && accountId !== null) {
      // Fee entries only: the money-moving entries (charge / payout /
      // refund) are covered by their source-object pages, and writing both
      // would double-count.
      if (o.type !== "stripe_fee" && o.type !== "fee") continue;
      const { row } = await recordTransactionRow(pool, audit, ctx, {
        account_id: accountId,
        external_transaction_id: o.id,
        amount: centsToDecimal(o.amount ?? 0),
        currency: currencyOf(o),
        direction: "outflow",
        transaction_date: isoFromEpoch(o.created),
        status: "posted",
        description_raw: o.description ?? "Stripe fee",
        ...common,
        confidence: TRANSACTION_CONFIDENCE,
      });
      created.push({ entity: "transaction", id: row.id });
      continue;
    }

    if (objectType === "customer") {
      const name = typeof o.name === "string" && o.name.length > 0 ? o.name : (o.email ?? o.id);
      const { row } = await upsertCounterpartyRow(pool, audit, ctx, {
        name,
        type: "customer",
        ...common,
        confidence: COUNTERPARTY_CONFIDENCE,
        metadata: { stripe: { customer_id: o.id, email: o.email ?? null } },
      });
      created.push({ entity: "counterparty", id: row.id });
      continue;
    }

    if (objectType === "dispute") {
      const { row: processor } = await upsertCounterpartyRow(pool, audit, ctx, {
        name: "Stripe",
        type: "other",
        ...common,
        confidence: COUNTERPARTY_CONFIDENCE,
      });
      const dueBy = o.evidence_details?.due_by;
      const { row } = await upsertObligationRow(pool, audit, ctx, {
        type: "other",
        counterparty_id: processor.id,
        amount_due: centsToDecimal(o.amount ?? 0),
        currency: currencyOf(o),
        due_date: isoFromEpoch(typeof dueBy === "number" ? dueBy : o.created),
        status: "disputed",
        direction: "payable",
        ...common,
        confidence: OBLIGATION_CONFIDENCE,
      });
      created.push({ entity: "counterparty", id: processor.id });
      created.push({ entity: "obligation", id: row.id });
      continue;
    }
  }

  return created;
}
