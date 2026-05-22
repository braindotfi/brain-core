import type { InternalAgentDefinition } from "@brain/schemas";

/** Personal Budget (consumer). Capability keccak256("personal_budget"). */
export const personalBudgetDefinition: InternalAgentDefinition = {
  agent_key: "personal_budget",
  display_name: "Personal Budget",
  provenance: "internal",
  category: "consumer",
  capabilities: ["personal_budget"],
  triggers: ["transaction.created", "budget.threshold_crossed", "spending.spike_detected"],
  intent_patterns: ["categorize my spending", "am i over budget", "how much did i spend"],
  readable_data: ["ledger:transactions", "ledger:categories", "wiki:cash_flow"],
  risk_level: "low",
  minimum_confidence: 0.7,
  required_evidence: ["transaction"],
  default_authority: "propose",
  enabled_by_default: true,
};
