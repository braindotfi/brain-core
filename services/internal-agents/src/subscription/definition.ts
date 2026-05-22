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
  readable_data: ["ledger:transactions", "ledger:counterparties", "wiki:counterparty"],
  risk_level: "low",
  minimum_confidence: 0.7,
  required_evidence: ["transaction"],
  default_authority: "propose",
  enabled_by_default: true,
};
