import {
  agentProposal,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/**
 * Cash Forecasting actions are advisory and never move funds. Forecast/report
 * actions carry a structured report payload; the rest are simple proposals.
 * All go through IAgentService.propose.
 */
const REPORT_ACTIONS = new Set(["generate_forecast", "create_runway_report"]);

export const cashForecastHandler: InternalAgentHandler = {
  agent_key: "cash_forecast",
  actions: ["generate_forecast", "recommend_action", "alert_shortfall", "create_runway_report"],
  build(input: HandlerInput): ProposedAction {
    if (REPORT_ACTIONS.has(input.action)) {
      return {
        channel: "agent",
        action: {
          type: input.action,
          report: {
            kind: "cash_forecast",
            basis: "ledger_balances",
            evidence_refs: input.evidence.items.map((i) => i.ref),
          },
        },
      };
    }
    return agentProposal(input);
  },
};
