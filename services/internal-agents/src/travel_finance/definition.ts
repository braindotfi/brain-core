import type { InternalAgentDefinition } from "@brain/schemas";

/** Travel Finance (consumer). Capability keccak256("travel_finance"). */
export const travelFinanceDefinition: InternalAgentDefinition = {
  agent_key: "travel_finance",
  display_name: "Travel Finance",
  provenance: "internal",
  category: "consumer",
  capabilities: ["travel_finance"],
  triggers: ["foreign_transaction.created", "travel.detected", "fx_fee.detected"],
  intent_patterns: ["which card for travel", "flag foreign fees", "summarize my trip spending"],
  readable_data: ["ledger:read"],
  risk_level: "low",
  minimum_confidence: 0.65,
  required_evidence: ["transaction"],
  default_authority: "propose",
  enabled_by_default: true,
  event_action_map: {
    "foreign_transaction.created": "flag_fee",
    "travel.detected": "recommend_card",
    "fx_fee.detected": "flag_fee",
  },
  default_action: "notify",
};
