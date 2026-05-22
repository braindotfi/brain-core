import type { InternalAgentDefinition } from "@brain/schemas";

/** Fraud & Anomaly (agnostic, high-risk). Capability keccak256("fraud_anomaly").
 *  Serves both consumer and business tenants. */
export const fraudAnomalyDefinition: InternalAgentDefinition = {
  agent_key: "fraud_anomaly",
  display_name: "Fraud & Anomaly",
  provenance: "internal",
  category: "agnostic",
  capabilities: ["fraud_anomaly"],
  triggers: ["transaction.unusual", "merchant.risk_detected", "duplicate_charge.detected"],
  intent_patterns: ["is this transaction fraud", "flag suspicious activity", "freeze my card"],
  readable_data: ["ledger:transactions", "wiki:counterparty", "raw:evidence"],
  risk_level: "high",
  minimum_confidence: 0.85,
  required_evidence: ["transaction"],
  default_authority: "notify_only",
  enabled_by_default: true,
};
