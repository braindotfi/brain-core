/**
 * §6 pre-execution gate types.
 *
 * The gate is a deterministic, ordered sequence of checks. Each check
 * is a pure predicate against Ledger / Policy / Approval state. No LLM.
 * No Wiki text. No side effects until the final commit step.
 *
 * On first failure, the gate short-circuits and the caller raises
 * `payment_intent_gate_failed` with the failing check index in details.
 *
 * On success, the gate has:
 *   - created a PolicyDecision row (step 12)
 *   - emitted an audit-before event (step 13a)
 * The caller is then responsible for emitting audit-after AFTER the
 * rail dispatch returns. The two events together form the §6 audit
 * pair.
 */

export type GateCheckName =
  | "agent_identity_verified"
  | "agent_behavior_pinned"
  | "agent_authorized"
  | "action_allowed"
  // 3.5 — on-chain settlement permitted for this tenant/payment-class (RFC 0001 §6.5).
  | "onchain_settlement_permitted"
  | "source_account_allowed"
  | "counterparty_allowed"
  // 5.5 — agent payee registered + attested in BrainMCPAgentRegistry, not paused (RFC 0001 §6.3).
  | "agent_counterparty_attested"
  | "counterparty_verified"
  // 6.5 — x402 settlement context (USDC/Base/amount/recipient) matches the intent (RFC 0001 §6.1).
  | "x402_payment_context_valid"
  // 6.6 — escrow lock state binds to the intent before release (RFC 0001 §6.2 / §7.6).
  | "escrow_state_bound"
  // 6.7 — outflow payment-intent must not target an obligation we are OWED
  // (a receivable). Batch 10 H-1: closes the "send money to a customer who
  // owes us" footgun the doc_obligation_v1 direction field always knew about
  // but the schema never persisted.
  | "obligation_direction_matches_flow"
  | "amount_within_limit"
  | "ledger_state_bound"
  | "available_balance_sufficient"
  // 8.5 — per-agent rolling-window spend stays within the policy envelope (RFC 0001 §6.4).
  | "micropayment_cap_within_window"
  | "required_evidence_present"
  | "evidence_supports_action"
  | "approval_requirement_determined"
  | "approval_granted_when_required"
  | "no_duplicate_payment"
  | "policy_decision_recorded"
  | "audit_before_emitted";

export interface GateCheck {
  /** 1-indexed; matches §6 spec ordering. */
  index: number;
  name: GateCheckName;
  passed: boolean;
  detail?: Record<string, unknown>;
}

export type GateOutcome = "allow" | "confirm" | "reject";

export interface GateSuccess {
  ok: true;
  /** True when this was a dry-run (no policy_decisions row, no audit emitted). */
  dryRun: boolean;
  outcome: GateOutcome;
  requiredApprovers: string[];
  /** Persisted PolicyDecision id; "" in dry-run (no row written). */
  policyDecisionId: string;
  /** Audit-before event id; "" in dry-run (no audit emitted). */
  auditBeforeEventId: string;
  /**
   * sha256 of the ledger state (source account + counterparty) the gate
   * resolved at execute — a verifiable, tamper-evident snapshot of what money
   * moved against (check 7.5). Also recorded on the audit-before event.
   */
  ledgerStateHash: string;
  trace: Array<Record<string, unknown>>;
  checks: GateCheck[];
}

export interface GateFailure {
  ok: false;
  dryRun: boolean;
  /** Policy outcome when the failure was after policy eval; null if before. */
  outcome: GateOutcome | null;
  requiredApprovers: string[];
  failedCheck: GateCheck;
  /** Earlier-passed checks; useful for the audit trail of the failure. */
  checks: GateCheck[];
  trace: Array<Record<string, unknown>>;
}

export type GateResult = GateSuccess | GateFailure;
