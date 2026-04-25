/**
 * IPolicyService — Layer 4 boundary contract.
 *
 * Owns versioned, signable policies and deterministic evaluation against
 * Ledger state. Returns PolicyDecision records that downstream layers
 * consume as proof.
 *
 * Layer boundary invariants:
 *  - Evaluators read Ledger state directly, never Wiki text.
 *  - Policy never executes payments. Policy never mutates Ledger or Audit.
 *  - Every evaluation creates one row in policy_decisions.
 *  - The §6 pre-execution gate runs deterministic Ledger checks; the
 *    PolicyDecision returned is the proof artifact the Agent layer
 *    requires before transitioning a PaymentIntent to executed.
 */

import type { ServiceCallContext } from "./types.js";

export interface PolicyDecision {
  id: string;
  policy_id: string;
  policy_version: number;
  subject_type: "payment_intent" | "wiki_question" | "agent_action";
  subject_id: string;
  outcome: "allow" | "confirm" | "reject";
  matched_rule_id: string | null;
  required_approvers: string[];
  ledger_snapshot_hash: string;
  trace: Array<Record<string, unknown>>;
  decided_at: string;
}

export interface EvaluateRequest {
  /** What is being decided. */
  subject_type: PolicyDecision["subject_type"];
  subject_id: string;
  /** The structured action under review. Validated against the policy DSL. */
  action: Record<string, unknown>;
}

export interface IPolicyService {
  getActive(ctx: ServiceCallContext): Promise<{ id: string; version: number; content: Record<string, unknown> } | null>;
  listVersions(ctx: ServiceCallContext): Promise<Array<{ id: string; version: number; state: string; activated_at: string | null }>>;
  evaluate(ctx: ServiceCallContext, req: EvaluateRequest): Promise<PolicyDecision>;
  getDecision(ctx: ServiceCallContext, decisionId: string): Promise<PolicyDecision | null>;
  simulate(ctx: ServiceCallContext, req: EvaluateRequest & { policy_version: number }): Promise<PolicyDecision>;
}
