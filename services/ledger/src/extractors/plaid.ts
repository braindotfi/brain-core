/**
 * Plaid → Ledger extractor.
 *
 * Replaces the v0.1 wiki extractor (services/wiki/src/extractors/plaid.ts).
 * Writes Ledger entities — accounts, counterparties, transactions —
 * instead of typed Wiki entities. Wiki page renderings derive downstream
 * (Phase 5) from the Ledger rows produced here.
 *
 * Plaid amount convention: positive = outflow from the account, negative
 * = inflow. We translate to the Ledger's non-negative amount + explicit
 * `direction` enum.
 *
 * Idempotency:
 *  - Account dedup by (owner_id, external_account_id).
 *  - Counterparty dedup by (owner_id, normalized_name, type).
 *  - Transaction dedup by (account_id, external_transaction_id).
 * Re-running the extractor against the same payload is a no-op.
 */

import type { AuditEmitter, ServiceCallContext } from "@brain/shared";
import type { Pool } from "pg";
import {
  recordTransactionRow,
  upsertAccountRow,
  upsertCounterpartyRow,
} from "../service/writes.js";

export interface PlaidAccountPayload {
  account_id: string;
  name: string;
  official_name?: string;
  type: "depository" | "credit" | "loan" | "investment" | "other";
  subtype?: string;
  iso_currency_code?: string | null;
  balances?: {
    current?: number | null;
    available?: number | null;
  };
}

export interface PlaidTransactionPayload {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  date: string;
  authorized_date?: string | null;
  name?: string;
  merchant_name?: string;
  pending?: boolean;
}

export interface PlaidExtractInput {
  rawParsedId: string;
  rawArtifactId: string;
  payload: Record<string, unknown>;
}

export interface ExtractedLedgerRow {
  entity: "account" | "counterparty" | "transaction";
  id: string;
}

/**
 * Extract Plaid payload into Ledger writes.
 *
 * Expected payload shape:
 * ```
 * {
 *   accounts?: PlaidAccountPayload[],
 *   transactions?: PlaidTransactionPayload[],
 * }
 * ```
 *
 * Either array may be missing; the extractor processes whichever subset
 * the parser produced. `accounts` are normalized first so the
 * transaction loop can resolve account_id → ledger account id.
 */
export async function normalizePlaidArtifact(
  pool: Pool,
  audit: AuditEmitter,
  ctx: ServiceCallContext,
  input: PlaidExtractInput,
): Promise<ExtractedLedgerRow[]> {
  const created: ExtractedLedgerRow[] = [];
  const sourceIds = [input.rawArtifactId];
  const evidenceIds = [input.rawParsedId];

  const accounts = Array.isArray(input.payload.accounts) ? input.payload.accounts : [];
  const transactions = Array.isArray(input.payload.transactions) ? input.payload.transactions : [];

  // 1. Accounts. Build a map external_account_id → ledger id for the next pass.
  const accountIdMap = new Map<string, string>();
  for (const rawAcct of accounts) {
    const acct = parsePlaidAccount(rawAcct);
    if (acct === null) continue;
    const { row } = await upsertAccountRow(pool, audit, ctx, {
      external_account_id: acct.account_id,
      ...(acct.official_name !== undefined ? { institution: acct.official_name } : {}),
      account_type: mapPlaidAccountType(acct.type, acct.subtype),
      name: acct.name,
      currency: (acct.iso_currency_code ?? "USD").toUpperCase(),
      current_balance: numericOrNull(acct.balances?.current),
      available_balance: numericOrNull(acct.balances?.available),
      status: "active",
      source_ids: sourceIds,
      evidence_ids: evidenceIds,
      provenance: "extracted",
      confidence: 0.95,
    });
    accountIdMap.set(acct.account_id, row.id);
    created.push({ entity: "account", id: row.id });
  }

  // 2. Transactions. Skip pending. For each tx: upsert counterparty (if
  //    merchant_name present), then record the transaction.
  for (const rawTx of transactions) {
    const tx = parsePlaidTransaction(rawTx);
    if (tx === null) continue;
    if (tx.pending === true) continue;
    const accountId = accountIdMap.get(tx.account_id);
    if (accountId === undefined) {
      // Caller passed transactions for an account we didn't see in this
      // payload. Skip rather than fail — partial Plaid syncs are normal.
      continue;
    }

    let counterpartyId: string | undefined;
    if (tx.merchant_name !== undefined && tx.merchant_name.length > 0) {
      const { row } = await upsertCounterpartyRow(pool, audit, ctx, {
        name: tx.merchant_name,
        type: "merchant",
        source_ids: sourceIds,
        evidence_ids: evidenceIds,
        provenance: "extracted",
        confidence: 0.7,
      });
      counterpartyId = row.id;
      created.push({ entity: "counterparty", id: row.id });
    }

    const direction: "inflow" | "outflow" = tx.amount >= 0 ? "outflow" : "inflow";
    const { row } = await recordTransactionRow(pool, audit, ctx, {
      account_id: accountId,
      external_transaction_id: tx.transaction_id,
      amount: centsToDecimal(Math.round(Math.abs(tx.amount) * 100)),
      currency: (tx.iso_currency_code ?? "USD").toUpperCase(),
      direction,
      transaction_date: new Date(tx.date).toISOString(),
      ...(tx.authorized_date !== null && tx.authorized_date !== undefined
        ? { posted_date: new Date(tx.authorized_date).toISOString() }
        : {}),
      ...(counterpartyId !== undefined ? { counterparty_id: counterpartyId } : {}),
      status: "posted",
      ...(tx.name !== undefined ? { description_raw: tx.name } : {}),
      ...(tx.merchant_name !== undefined ? { description_normalized: tx.merchant_name } : {}),
      source_ids: sourceIds,
      evidence_ids: evidenceIds,
      provenance: "extracted",
      confidence: 0.9,
    });
    created.push({ entity: "transaction", id: row.id });
  }

  return created;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapPlaidAccountType(
  type: PlaidAccountPayload["type"],
  subtype?: string,
): "bank_checking" | "bank_savings" | "card" | "loan" | "line_of_credit" | "onchain" {
  if (type === "depository" && subtype === "savings") return "bank_savings";
  if (type === "depository") return "bank_checking";
  if (type === "credit" && subtype === "line of credit") return "line_of_credit";
  if (type === "credit") return "card";
  if (type === "loan") return "loan";
  // Investment & other map to bank_checking as a safe default until the
  // Ledger gains more account_type values; this preserves existing
  // CHECK-constraint compatibility.
  return "bank_checking";
}

function numericOrNull(v: number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (!Number.isFinite(v)) return null;
  return v.toFixed(8);
}

function centsToDecimal(cents: number): string {
  const whole = Math.trunc(cents / 100).toString();
  const frac = (cents % 100).toString().padStart(2, "0");
  return `${whole}.${frac}`;
}

function parsePlaidAccount(raw: unknown): PlaidAccountPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const acct = raw as Partial<PlaidAccountPayload>;
  if (typeof acct.account_id !== "string" || acct.account_id.length === 0) return null;
  if (typeof acct.name !== "string" || acct.name.length === 0) return null;
  if (typeof acct.type !== "string") return null;
  return acct as PlaidAccountPayload;
}

function parsePlaidTransaction(raw: unknown): PlaidTransactionPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const tx = raw as Partial<PlaidTransactionPayload>;
  if (typeof tx.transaction_id !== "string" || tx.transaction_id.length === 0) return null;
  if (typeof tx.account_id !== "string" || tx.account_id.length === 0) return null;
  if (typeof tx.amount !== "number" || !Number.isFinite(tx.amount)) return null;
  if (typeof tx.date !== "string" || Number.isNaN(new Date(tx.date).getTime())) return null;
  if (tx.iso_currency_code !== null && tx.iso_currency_code !== undefined) {
    if (typeof tx.iso_currency_code !== "string" || tx.iso_currency_code.length === 0) return null;
  }
  return tx as PlaidTransactionPayload;
}
