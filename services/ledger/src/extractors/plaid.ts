/**
 * Plaid parser validation for the canonical connector cutover.
 *
 * Plaid rows no longer write Ledger entities here. The raw normalize worker
 * still consumes `plaid_tx_v1` rows so malformed parser output is surfaced,
 * but accounts and transactions now flow raw_parsed -> canonical_account /
 * canonical_transaction -> Ledger projection.
 */

import type { AuditEmitter, ServiceCallContext } from "@brain/shared";
import { brainError } from "@brain/shared";
import type { Pool } from "pg";

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

export async function normalizePlaidArtifact(
  _pool: Pool,
  _audit: AuditEmitter,
  _ctx: ServiceCallContext,
  input: PlaidExtractInput,
): Promise<ExtractedLedgerRow[]> {
  validatePlaidPayload(input.payload);
  return [];
}

function validatePlaidPayload(payload: Record<string, unknown>): void {
  const accounts = payload["accounts"];
  const transactions = payload["transactions"];
  if (accounts !== undefined && !Array.isArray(accounts)) {
    throw brainError("ledger_row_invalid", "plaid_tx_v1: accounts must be an array");
  }
  if (transactions !== undefined && !Array.isArray(transactions)) {
    throw brainError("ledger_row_invalid", "plaid_tx_v1: transactions must be an array");
  }
}
