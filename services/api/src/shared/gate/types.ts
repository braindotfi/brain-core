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
  | "agent_authorized"
  | "action_allowed"
  | "source_account_allowed"
  | "counterparty_allowed"
  | "counterparty_verified"
  | "amount_within_limit"
  | "available_balance_sufficient"
  | "required_evidence_present"
  | "approval_requirement_determined"
  | "approval_granted_when_required"
  | "policy_decision_recorded"
  | "audit_before_emitted";

export interface GateCheck {
  /** 1-indexed; matches §6 spec ordering. */
  index: number;
  name: GateCheckName;
  passed: boolean;
  detail?: Record<string, unknown>;
}

export interface GateSuccess {
  ok: true;
  policyDecisionId: string;
  auditBeforeEventId: string;
  checks: GateCheck[];
}

export interface GateFailure {
  ok: false;
  failedCheck: GateCheck;
  /** Earlier-passed checks; useful for the audit trail of the failure. */
  checks: GateCheck[];
}

export type GateResult = GateSuccess | GateFailure;
