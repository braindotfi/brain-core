import type { InternalAgentDefinition } from "@brain/schemas";

export const amlComplianceDefinition: InternalAgentDefinition = {
  agent_key: "aml_compliance",
  display_name: "AML Compliance",
  provenance: "internal",
  category: "business",
  capabilities: ["aml_compliance"],
  triggers: [
    "payment.cross_border_created",
    "payment.above_regulatory_threshold",
    "kyc.beneficiary_stale",
    "ofac.list_updated",
  ],
  intent_patterns: [
    "review aml documents",
    "check wire compliance",
    "screen beneficiary",
    "hold cross border payment",
  ],
  readable_data: ["ledger:read", "raw:read", "wiki:read"],
  risk_level: "high",
  minimum_confidence: 0.85,
  required_evidence: [
    { kind: "payment_intent", weight: 0.4, required: false },
    { kind: "counterparty", weight: 0.2, required: true },
    { kind: "kyc", weight: 0.2, required: false },
    { kind: "screening", weight: 0.2, required: false },
  ],
  default_authority: "propose",
  enabled_by_default: true,
  event_action_map: {
    "payment.cross_border_created": "hold",
    "payment.above_regulatory_threshold": "hold",
    "kyc.beneficiary_stale": "provide_docs",
    "ofac.list_updated": "hold",
  },
};
