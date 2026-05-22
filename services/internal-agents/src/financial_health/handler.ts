import {
  agentProposal,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/** Financial Health actions are advisory (score, recommend, summarize, notify);
 *  all go through IAgentService.propose. */
export const financialHealthHandler: InternalAgentHandler = {
  agent_key: "financial_health",
  actions: ["generate_health_score", "recommend_action", "create_monthly_summary", "notify"],
  build(input: HandlerInput): ProposedAction {
    return agentProposal(input);
  },
};
