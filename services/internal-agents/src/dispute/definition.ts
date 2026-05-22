import type { InternalAgentDefinition } from "@brain/schemas";

/** Dispute (business). Capability keccak256("dispute_evidence"). Heavy Wiki + Raw reads. */
export const disputeDefinition: InternalAgentDefinition = {
  agent_key: "dispute",
  display_name: "Dispute",
  provenance: "internal",
  category: "business",
  capabilities: ["dispute_evidence"],
  triggers: ["dispute.created", "chargeback.received", "payment.mismatch"],
  intent_patterns: ["gather dispute evidence", "respond to a chargeback", "build a dispute packet"],
  readable_data: ["ledger:transactions", "wiki:counterparty", "wiki:invoice", "raw:evidence"],
  risk_level: "medium",
  minimum_confidence: 0.75,
  required_evidence: ["dispute", "transaction"],
  default_authority: "propose",
  enabled_by_default: true,
};
