import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";

/** H-07 Proof artifact (mirrors shared/src/contracts/proof.ts). */
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
  behavior_hash: string | null;
  outcome: ProofOutcome;
  policy_version: string;
  policy_hash: string;
  matched_rule_id: string | null;
  gate_checks: ProofGateCheck[];
  evidence: ProofEvidence[];
  ledger_snapshot_hash: string;
  audit_events: ProofAuditEvent[];
  merkle_root: string;
  merkle_proof: string[];
  chain_anchor: ProofChainAnchor | null;
  rail_receipt: Record<string, unknown> | null;
  human_explanation: string;
}

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

export class ProofResource {
  constructor(private readonly http: BrainHttpClient) {}

  /**
   * Fetch the canonical, verifiable proof for an action (PaymentIntent or
   * agent-action id). Throws BrainAPIError(404) if no proof exists for the
   * caller's tenant.
   */
  async get(actionId: string): Promise<Proof> {
    const { data, error, response } = await this.http.GET("/proof/{action_id}", {
      params: { path: { action_id: actionId } },
    });
    // The generated response type uses loose array shapes; the server contract
    // (schemas/proof.schema.json) guarantees the strict Proof shape.
    return unwrap(data, error, response.status) as unknown as Proof;
  }
}
