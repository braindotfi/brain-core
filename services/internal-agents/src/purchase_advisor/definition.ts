import type { InternalAgentDefinition } from "@brain/schemas";

/** Purchase Advisor (consumer). Capability keccak256("purchase_advisor"). More
 *  intent-driven than event-driven: the classifier maps "can I afford X" here. */
export const purchaseAdvisorDefinition: InternalAgentDefinition = {
  agent_key: "purchase_advisor",
  display_name: "Purchase Advisor",
  provenance: "internal",
  category: "consumer",
  capabilities: ["purchase_advisor"],
  triggers: ["purchase_intent.created", "large_transaction.detected"],
  intent_patterns: [
    "can i afford this",
    "should i buy this",
    "is this a good purchase",
    "can i afford",
  ],
  readable_data: ["ledger:read", "wiki:read"],
  risk_level: "medium",
  minimum_confidence: 0.75,
  required_evidence: ["balance"],
  default_authority: "notify_only",
  enabled_by_default: true,
  event_action_map: {
    "purchase_intent.created": "approve_recommendation",
    "large_transaction.detected": "warn",
  },
  intent_action_map: [
    {
      patterns: ["should i buy this", "can i afford this", "is this a good purchase"],
      action: "approve_recommendation",
    },
    { patterns: ["should i wait", "should i delay this purchase"], action: "recommend_delay" },
  ],
  default_action: "warn",
};
