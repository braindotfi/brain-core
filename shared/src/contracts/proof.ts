/**
 * H-07 Proof artifact — the canonical, customer-/auditor-facing proof that a
 * Brain action was gated, evidenced, and recorded on an append-only,
 * on-chain-anchored audit chain.
 *
 * This is a READ-ONLY projection assembled from data that already exists across
 * layers (Ledger PaymentIntent, Policy decision, the §6 gate trace, Raw
 * evidence, the Audit Merkle chain + on-chain anchor, the rail receipt). It is
 * never a source of truth — `GET /v1/proof/{action_id}` re-derives it on each
 * call. `human_explanation` is a Wiki-rendered narrative view (derived, never
 * authoritative).
 */

/** One §6 gate check in the proof trace (public shape: name is a plain string). */
export interface ProofGateCheck {
  index: number;
  name: string;
  passed: boolean;
  detail?: Record<string, unknown>;
}

export interface ProofEvidence {
  raw_parsed_id: string;
  sha256: string;
  source_type: string;
  kind: string;
  trust_level: string;
}

export interface ProofAuditEvent {
  id: string;
  action: string;
  layer: string;
  event_hash: string;
  prev_event_hash: string | null;
  created_at: string;
}

export interface ProofChainAnchor {
  tx_hash: string;
  block_number: number;
  contract_address: string;
  chain: "base" | "base-sepolia";
}

export type ProofOutcome =
  | "allowed"
  | "confirmed"
  | "rejected"
  | "executed"
  | "failed"
  | "shadow_completed";

export interface Proof {
  action_id: string;
  tenant_id: string;
  agent_id: string;
  /** null if the agent has no registered runtime behavior hash. */
  behavior_hash: string | null;
  outcome: ProofOutcome;
  policy_version: string;
  /** Content hash matching BrainPolicyRegistry. */
  policy_hash: string;
  matched_rule_id: string | null;
  /** Full §6 check trace from the GateResult recorded at execute. */
  gate_checks: ProofGateCheck[];
  evidence: ProofEvidence[];
  /** sha256 of the Ledger state the action moved against (H-08). */
  ledger_snapshot_hash: string;
  audit_events: ProofAuditEvent[];
  merkle_root: string;
  merkle_proof: string[];
  /** null if the anchor has not been broadcast on-chain yet. */
  chain_anchor: ProofChainAnchor | null;
  rail_receipt: Record<string, unknown> | null;
  human_explanation: string;
}
