import type { InternalAgentDefinition } from "@brain/schemas";

/** Cash Forecasting (business, low-risk, no fund movement). Capability keccak256("cash_forecast"). */
export const cashForecastDefinition: InternalAgentDefinition = {
  agent_key: "cash_forecast",
  display_name: "Cash Forecasting",
  provenance: "internal",
  category: "business",
  capabilities: ["cash_forecast"],
  triggers: ["forecast.requested", "cashflow.material_change", "large_payable.created"],
  intent_patterns: ["forecast our cash", "what is our runway", "project cash flow"],
  readable_data: ["ledger:accounts", "ledger:balances", "ledger:obligations", "wiki:cash_flow"],
  risk_level: "low",
  minimum_confidence: 0.65,
  required_evidence: ["balance"],
  default_authority: "propose",
  enabled_by_default: true,
  event_action_map: {
    "forecast.requested": "generate_forecast",
    "cashflow.material_change": "recommend_action",
    "large_payable.created": "alert_shortfall",
  },
  default_action: "generate_forecast",
};
