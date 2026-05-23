import type { InternalAgentDefinition } from "@brain/schemas";

/**
 * Subscription (agnostic). Capability keccak256("subscription_review").
 *
 * Category is `agnostic`: Phase 3 sets consumer-specific policy defaults for
 * THIS SAME agent. There is no separate consumer subscription agent.
 */
export const subscriptionDefinition: InternalAgentDefinition = {
  agent_key: "subscription",
  display_name: "Subscription",
  provenance: "internal",
  category: "agnostic",
  capabilities: ["subscription_review"],
  triggers: [
    "recurring_charge.detected",
    "vendor.duplicate_detected",
    "subscription.price_changed",
  ],
  intent_patterns: [
    "review my subscriptions",
    "cancel duplicate subscription",
    "flag a price increase",
  ],
  readable_data: ["ledger:read", "wiki:read"],
  risk_level: "low",
  minimum_confidence: 0.7,
  required_evidence: ["transaction"],
  default_authority: "propose",
  enabled_by_default: true,
  // Counterparty-facing: draft_vendor_email is reachable only via explicit request,
  // never a trigger default (template-approval flow lands in Phase 2.7).
  event_action_map: {
    "recurring_charge.detected": "flag_subscription",
    "vendor.duplicate_detected": "recommend_cancel",
    "subscription.price_changed": "flag_subscription",
  },
  default_action: "flag_subscription",
};
