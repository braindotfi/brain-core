/**
 * IReconciliationService — Layer 2 sub-boundary.
 *
 * Owns the reconciliation matcher: pairs Ledger entities and writes
 * `ledger_reconciliation_matches` rows. Implementation lands in
 * services/ledger/src/reconciliation/ in Phase 5.
 *
 * Match types (§3 Layer 2 of Brain_MVP_Architecture.md):
 *   transaction_receipt    bank tx ↔ document(receipt)
 *   invoice_payment        invoice ↔ transaction
 *   statement_balance      document(bank_statement) ↔ balance
 *   wallet_transfer        on-chain tx ↔ exchange deposit tx
 *   payroll_bank_debit     payroll obligation ↔ transaction
 *   subscription_charge    subscription obligation ↔ transaction
 *   card_charge            card-statement obligation ↔ transaction
 *
 * Matches are append-only beyond status transitions; conflict detection
 * lives in `status = duplicate_possible` rather than mutating an existing
 * match.
 */

import type { ServiceCallContext } from "./types.js";

export type MatchType =
  | "transaction_receipt"
  | "invoice_payment"
  | "statement_balance"
  | "wallet_transfer"
  | "payroll_bank_debit"
  | "subscription_charge"
  | "card_charge"
  | "onchain_settlement"
  // Phase 4 resolution: two observations of the same payable from different
  // sources (document tier vs accounting aggregator), linked not merged.
  | "obligation_duplicate";

export type MatchEntityType =
  | "transaction"
  | "invoice"
  | "obligation"
  | "document"
  | "balance"
  | "transfer";

export interface ReconciliationMatch {
  id: string;
  owner_id: string;
  match_type: MatchType;
  left_entity_type: MatchEntityType;
  left_entity_id: string;
  right_entity_type: MatchEntityType;
  right_entity_id: string;
  confidence_score: number;
  status:
    | "unmatched"
    | "matched"
    | "partially_matched"
    | "duplicate_possible"
    | "disputed"
    | "cleared"
    | "failed"
    | "reversed";
  evidence_ids: string[];
  explanation: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunReconciliationRequest {
  since?: string;
  match_types?: MatchType[];
}

export interface IReconciliationService {
  /** Enqueue a reconciliation run. Returns a job id. */
  run(ctx: ServiceCallContext, req: RunReconciliationRequest): Promise<{ job_id: string }>;

  /** Read-side queries. */
  list(
    ctx: ServiceCallContext,
    f: { status?: ReconciliationMatch["status"]; match_type?: MatchType; limit?: number },
  ): Promise<ReconciliationMatch[]>;

  /** Manually mark a candidate match disputed or cleared. */
  setStatus(
    ctx: ServiceCallContext,
    matchId: string,
    next: ReconciliationMatch["status"],
    explanation?: string,
  ): Promise<ReconciliationMatch>;
}
