import type { InternalAgentDefinition } from "@brain/schemas";

/** Compliance (business, high-risk). Capability keccak256("compliance_monitor").
 *  Typically notify_only or confirm; never auto-executes. */
export const complianceDefinition: InternalAgentDefinition = {
  agent_key: "compliance",
  display_name: "Compliance",
  provenance: "internal",
  category: "business",
  capabilities: ["compliance_monitor"],
  triggers: ["policy.violation", "approval.missing", "audit.gap_detected"],
  intent_patterns: ["check compliance", "flag a policy violation", "review an audit gap"],
  readable_data: ["policy:decisions", "audit:events", "ledger:payment_intents"],
  risk_level: "high",
  minimum_confidence: 0.8,
  required_evidence: ["policy_decision", "audit_event"],
  default_authority: "notify_only",
  enabled_by_default: true,
};
