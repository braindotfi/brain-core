import type { InternalAgentDefinition } from "@brain/schemas";

/** Financial Health (consumer). Capability keccak256("financial_health"). Mostly scheduled (monthly). */
export const financialHealthDefinition: InternalAgentDefinition = {
  agent_key: "financial_health",
  display_name: "Financial Health",
  provenance: "internal",
  category: "consumer",
  capabilities: ["financial_health"],
  triggers: ["monthly.health_check", "income.changed", "spending.changed", "cash.reserve_changed"],
  intent_patterns: [
    "how is my financial health",
    "what is my health score",
    "monthly financial summary",
  ],
  readable_data: ["ledger:read", "wiki:read"],
  risk_level: "low",
  minimum_confidence: 0.65,
  required_evidence: ["balance", "transaction"],
  default_authority: "notify_only",
  enabled_by_default: true,
  event_action_map: {
    "monthly.health_check": "generate_health_score",
    "income.changed": "recommend_action",
    "spending.changed": "recommend_action",
    "cash.reserve_changed": "recommend_action",
  },
  default_action: "generate_health_score",
};
