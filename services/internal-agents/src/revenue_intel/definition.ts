import type { InternalAgentDefinition } from "@brain/schemas";

/** Revenue Intelligence (business, low-risk). Capability keccak256("revenue_intel").
 *  Almost all proposals are notifications. */
export const revenueIntelDefinition: InternalAgentDefinition = {
  agent_key: "revenue_intel",
  display_name: "Revenue Intelligence",
  provenance: "internal",
  category: "business",
  capabilities: ["revenue_intel"],
  triggers: ["revenue.changed", "customer.payment_behavior_changed", "contract.renewal_upcoming"],
  intent_patterns: ["analyze revenue", "flag churn risk", "find expansion opportunities"],
  readable_data: ["ledger:read", "wiki:read"],
  risk_level: "low",
  minimum_confidence: 0.65,
  required_evidence: ["invoice", "transaction"],
  default_authority: "notify_only",
  enabled_by_default: true,
  event_action_map: {
    "revenue.changed": "create_revenue_summary",
    "customer.payment_behavior_changed": "flag_churn_risk",
    "contract.renewal_upcoming": "identify_expansion_opportunity",
  },
  default_action: "create_revenue_summary",
};
