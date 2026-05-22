import type { InternalAgentDefinition } from "@brain/schemas";

/** Savings (consumer). Capability keccak256("savings_sweep"). Consumer counterpart
 *  to business Treasury; shares the cash.balance_high trigger (category-routed). */
export const savingsDefinition: InternalAgentDefinition = {
  agent_key: "savings",
  display_name: "Savings",
  provenance: "internal",
  category: "consumer",
  capabilities: ["savings_sweep"],
  triggers: ["income.received", "cash.balance_high", "savings.goal_progress_changed"],
  intent_patterns: [
    "help me save",
    "move money to savings",
    "sweep to savings",
    "how is my savings goal",
  ],
  readable_data: ["ledger:accounts", "ledger:balances", "wiki:cash_flow"],
  risk_level: "low",
  minimum_confidence: 0.75,
  required_evidence: ["balance"],
  default_authority: "propose",
  enabled_by_default: true,
};
