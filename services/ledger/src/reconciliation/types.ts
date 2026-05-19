/**
 * Reconciliation matcher framework.
 *
 * A matcher takes recent unmatched left-side entities, fetches candidate
 * right-side entities, scores each pair, and writes a
 * `ledger_reconciliation_matches` row when the score crosses a per-matcher
 * threshold. Matchers are deterministic — no LLM, no Wiki text — and
 * idempotent (same inputs produce the same matches).
 *
 * Per Brain_MVP_Architecture.md §3 Layer 2, MVP ships seven match types:
 *
 *   transaction_receipt     bank tx ↔ ledger_documents(receipt)
 *   invoice_payment         ledger_invoices ↔ ledger_transactions
 *   statement_balance       ledger_documents(bank_statement) ↔ ledger_balances
 *   wallet_transfer         on-chain ledger_transactions ↔ exchange deposits
 *   payroll_bank_debit      payroll obligation ↔ outflow tx
 *   subscription_charge     subscription obligation ↔ recurring tx
 *   card_charge             card_statement obligation ↔ tx
 *
 * Output (per match):
 *   - ledger_reconciliation_matches row with status, confidence, evidence
 *   - audit event `ledger.reconciliation.matched`
 *
 * Phase 5 ships full implementations of `transaction_receipt` and
 * `invoice_payment`. The other five are stubs that document their criteria
 * but produce zero matches; they're filled in by dedicated PRs that pair
 * with the corresponding source-adapter work.
 */

import type { AuditEmitter, MatchType, ServiceCallContext } from "@brain/shared";
import type { Pool } from "pg";

export interface MatcherContext {
  pool: Pool;
  audit: AuditEmitter;
}

export interface MatcherInput {
  ctx: ServiceCallContext;
  /** Inclusive lower bound; defaults to 30 days ago when null. */
  since: Date | null;
  /** Hard cap on matches written per run. */
  maxMatches: number;
}

export interface MatchProduced {
  matchId: string;
  matchType: MatchType;
  leftEntityType: string;
  leftEntityId: string;
  rightEntityType: string;
  rightEntityId: string;
  confidenceScore: number;
}

export interface MatcherResult {
  matchType: MatchType;
  matchesProduced: MatchProduced[];
  /** Number of left-side rows the matcher considered. */
  candidatesScanned: number;
  /** Diagnostic notes returned with /ledger/reconcile responses. */
  notes?: string;
}

export interface Matcher {
  readonly matchType: MatchType;
  run(deps: MatcherContext, input: MatcherInput): Promise<MatcherResult>;
}
