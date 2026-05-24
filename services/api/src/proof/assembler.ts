/**
 * H-07 Proof assembler.
 *
 * Pure projection: given a fully-fetched `ProofSources` bundle (gathered by
 * fetchProofSources under a tenant scope), produce the canonical Proof minus
 * its narrative `human_explanation` (rendered separately by the Wiki layer so
 * the "Wiki is a derived view, never source of truth" invariant holds — the
 * renderer reads the structured proof, not the other way around).
 *
 * Keeping assembly pure makes every outcome path unit-testable without a DB.
 * The DB-dependent gathering lives in fetchProofSources.ts and is verified
 * against Postgres (blocked in the sandbox — see the H-07 summary).
 */

import type {
  Proof,
  ProofAuditEvent,
  ProofChainAnchor,
  ProofEvidence,
  ProofGateCheck,
  ProofOutcome,
} from "@brain/shared";

/** Everything assembleProof needs, already fetched + tenant-scoped. */
export interface ProofSources {
  actionId: string;
  tenantId: string;
  paymentIntent: {
    id: string;
    created_by_agent_id: string | null;
    /** proposed | approved | dispatching | executed | failed | rejected | … */
    status: string;
  };
  /** True when the originating agent run was shadow-mode (no real dispatch). */
  shadow: boolean;
  policyDecision: {
    policy_version: number;
    matched_rule_id: string | null;
    ledger_snapshot_hash: string;
    outcome: "allow" | "confirm" | "reject";
  } | null;
  /** BrainPolicyRegistry content hash for the decision's policy version. */
  policyHash: string | null;
  /** Registered runtime behavior hash of the originating agent, if any. */
  behaviorHash: string | null;
  gateChecks: ProofGateCheck[];
  evidence: ProofEvidence[];
  auditEvents: ProofAuditEvent[];
  merkleRoot: string;
  merkleProof: string[];
  chainAnchor: ProofChainAnchor | null;
  railReceipt: Record<string, unknown> | null;
}

/** Proof without the Wiki-rendered narrative — produced by the pure assembler. */
export type ProofCore = Omit<Proof, "human_explanation">;

/**
 * Derive the customer-facing outcome from the PaymentIntent lifecycle + policy
 * outcome. Shadow runs are reported as shadow_completed regardless of status
 * (the audit chain is real even though no money moved).
 */
export function deriveProofOutcome(sources: ProofSources): ProofOutcome {
  if (sources.shadow) return "shadow_completed";
  switch (sources.paymentIntent.status) {
    case "executed":
      return "executed";
    case "failed":
      return "failed";
    case "rejected":
      return "rejected";
    case "dispatching":
    case "approved":
      // Gated + approved, settlement pending/async (H-04). Reflect the policy
      // verdict: confirm => confirmed, allow => allowed.
      return sources.policyDecision?.outcome === "confirm" ? "confirmed" : "allowed";
    default:
      // proposed / pending_approval / cancelled and anything else.
      return sources.policyDecision?.outcome === "reject" ? "rejected" : "allowed";
  }
}

export function assembleProof(sources: ProofSources): ProofCore {
  const pd = sources.policyDecision;
  return {
    action_id: sources.actionId,
    tenant_id: sources.tenantId,
    agent_id: sources.paymentIntent.created_by_agent_id ?? "",
    behavior_hash: sources.behaviorHash,
    outcome: deriveProofOutcome(sources),
    policy_version: pd === null ? "" : String(pd.policy_version),
    policy_hash: sources.policyHash ?? "",
    matched_rule_id: pd?.matched_rule_id ?? null,
    gate_checks: sources.gateChecks,
    evidence: sources.evidence,
    ledger_snapshot_hash: pd?.ledger_snapshot_hash ?? "",
    audit_events: sources.auditEvents,
    merkle_root: sources.merkleRoot,
    merkle_proof: sources.merkleProof,
    // Shadow actions never dispatched a rail — force null for honesty even if a
    // stale receipt were somehow present.
    chain_anchor: sources.chainAnchor,
    rail_receipt: sources.shadow ? null : sources.railReceipt,
  };
}

export type { ProofAuditEvent, ProofChainAnchor, ProofEvidence, ProofGateCheck };
