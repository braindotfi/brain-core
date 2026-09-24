import type { InternalAgentDefinition } from "@brain/schemas";

export const subscriptionManagementDefinition: InternalAgentDefinition = {
  agent_key: "subscription_management",
  display_name: "Subscription Management",
  provenance: "internal",
  category: "business",
  capabilities: ["subscription_management"],
  triggers: [
    "recurring_charge.detected",
    "vendor.duplicate_detected",
    "subscription.price_changed",
    "subscription.seats_underutilized",
    "subscription.new_signup_detected",
  ],
  intent_patterns: [
    "review saas seats",
    "downgrade unused seats",
    "renegotiate subscription",
    "cancel subscription renewal",
  ],
  readable_data: ["ledger:read", "raw:read", "wiki:read"],
  risk_level: "medium",
  minimum_confidence: 0.75,
  required_evidence: [
    { kind: "transaction", weight: 0.25, required: true },
    { kind: "subscription", weight: 0.25, required: false },
    { kind: "directory_usage", weight: 0.35, required: false },
    { kind: "contract", weight: 0.15, required: false },
  ],
  default_authority: "propose",
  enabled_by_default: true,
  event_action_map: {
    "subscription.seats_underutilized": "downgrade",
    "subscription.new_signup_detected": "renew",
    "recurring_charge.detected": "renew",
    "vendor.duplicate_detected": "cancel",
    "subscription.price_changed": "renegotiate",
  },
  default_action: "renew",
};
