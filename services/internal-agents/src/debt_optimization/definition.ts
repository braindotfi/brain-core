import type { InternalAgentDefinition } from "@brain/schemas";

/** Debt Optimization (consumer). Capability keccak256("debt_optimization"). */
export const debtOptimizationDefinition: InternalAgentDefinition = {
  agent_key: "debt_optimization",
  display_name: "Debt Optimization",
  provenance: "internal",
  category: "consumer",
  capabilities: ["debt_optimization"],
  triggers: ["debt.payment_due", "interest_rate.changed", "cash.available_for_debt_paydown"],
  intent_patterns: ["pay down debt", "optimize my debt", "should i pay off my loan"],
  readable_data: ["ledger:obligations", "ledger:accounts", "wiki:cash_flow"],
  risk_level: "medium",
  minimum_confidence: 0.75,
  required_evidence: ["obligation"],
  default_authority: "notify_only",
  enabled_by_default: true,
};
