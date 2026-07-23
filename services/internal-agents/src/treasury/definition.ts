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
    "ledger.upload.projected",
  ],
  intent_patterns: [
    "sweep idle cash",
    "move excess balance to yield",
    "top up low balance account",
    "plan liquidity",
  ],
  readable_data: ["ledger:read", "wiki:read"],
  risk_level: "medium",
  minimum_confidence: 0.8,
  required_evidence: ["balance"],
  default_authority: "propose",
  enabled_by_default: true,
  // Money-mover: no default_action — an unmatched event surfaces as missing_action.
  event_action_map: {
    "cash.balance_high": "recommend_cash_sweep",
    "cash.balance_low": "alert_low_balance",
    "runway.changed": "create_liquidity_plan",
    "yield_opportunity.detected": "recommend_cash_sweep",
    "ledger.upload.projected": "create_liquidity_plan",
  },
};
