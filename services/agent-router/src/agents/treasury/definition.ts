import type { InternalAgentDefinition } from "@brain/schemas";

/** Treasury (business). Capability keccak256("treasury_sweep"). */
export const treasuryDefinition: InternalAgentDefinition = {
  agent_key: "treasury",
  display_name: "Treasury",
  provenance: "internal",
  category: "business",
  capabilities: ["treasury_sweep"],
  triggers: [
    "cash.balance_high",
    "cash.balance_low",
    "runway.changed",
    "yield_opportunity.detected",
  ],
  intent_patterns: [
    "sweep idle cash",
    "move excess balance to yield",
    "top up low balance account",
    "plan liquidity",
  ],
  readable_data: ["ledger:accounts", "ledger:balances", "ledger:transactions", "wiki:cash_flow"],
  risk_level: "medium",
  minimum_confidence: 0.8,
  required_evidence: ["balance"],
  default_authority: "propose",
  enabled_by_default: true,
};
