/**
 * IAgentService — Layer 5 boundary contract.
 *
 * Owns agent identity, scope, tasks, proposals, recommendations, and action
 * orchestration. The Agent layer proposes and orchestrates — it does NOT
 * execute financial actions directly. Execution happens through provider
 * rails under the §6 pre-execution gate.
 *
 * Layer boundary invariants:
 *  - Agents never mutate Raw / Ledger / Policy / Audit stores directly.
 *  - Every Ledger write that originates from agent reasoning goes through
 *    ILedgerService methods (which emit audit events).
 *  - Every payment goes through PaymentIntent (IPaymentIntentService) with
 *    a PolicyDecision and the §6 gate.
 *  - No financial execution path bypasses Policy.
 */

import type { ServiceCallContext } from "./types.js";

export interface AgentRecord {
  id: string;
  // `kind` is the agent's provenance — matches InternalAgentDefinition.provenance.
  kind: "internal" | "external";
  // Domain function. Extended additively as internal agents ship.
  /**
   * Domain function. Extended additively as internal agents ship.
   *
   * Batch 10 H-3: split `partner` into two roles.
   *   - `partner` (default): READ + PROPOSE + APPROVE, no payment_intent:execute.
   *   - `partner_execute` (opt-in): the elevated role explicitly carries execute.
   *
   * Operators must register an agent with `partner_execute` to mint a tokenable
   * execute scope. The default `partner` role cannot auto-upgrade.
   */
  role:
    | "reconciliation"
    | "payment"
    | "anomaly"
    | "partner"
    | "partner_execute"
    | "collections"
    | "treasury";
  display_name: string;
  scope_hash: string | null;
  onchain_address: string | null;
  state: "pending_onchain" | "active" | "revoked" | "failed" | "quarantined";
  registered_tx: string | null;
  registered_at: string | null;
}

export interface ProposalInput {
  /** Free-form action; validated against the policy DSL on evaluation. */
  action: Record<string, unknown>;
}

export interface ProposalRecord {
  id: string;
  proposing_agent_id: string;
  action: Record<string, unknown>;
  policy_decision_id: string;
  status:
    | "pending"
    | "approved"
    | "acknowledged"
    | "reconciling"
    | "rejected"
    | "executed"
    | "failed"
    | "undone"
    | "unknown";
  approvers_signed: string[];
  created_at: string;
}

export interface IAgentService {
  list(ctx: ServiceCallContext): Promise<AgentRecord[]>;
  get(ctx: ServiceCallContext, agentId: string): Promise<AgentRecord | null>;
  register(
    ctx: ServiceCallContext,
    input: Omit<AgentRecord, "state" | "registered_at">,
  ): Promise<AgentRecord>;

  /** Non-financial proposal. Financial actions use IPaymentIntentService. */
  propose(ctx: ServiceCallContext, agentId: string, input: ProposalInput): Promise<ProposalRecord>;

  listActions(ctx: ServiceCallContext, agentId: string, limit: number): Promise<ProposalRecord[]>;
  approve(ctx: ServiceCallContext, proposalId: string): Promise<ProposalRecord>;
  reject(ctx: ServiceCallContext, proposalId: string, reason?: string): Promise<ProposalRecord>;
  escalate(ctx: ServiceCallContext, proposalId: string, note?: string): Promise<void>;
}
