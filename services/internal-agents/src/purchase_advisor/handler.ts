import {
  agentProposal,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/** Purchase Advisor actions are advisory (approve recommendation, warn, suggest);
 *  all go through IAgentService.propose. It never makes a purchase. */
export const purchaseAdvisorHandler: InternalAgentHandler = {
  agent_key: "purchase_advisor",
  actions: ["approve_recommendation", "warn", "recommend_delay", "suggest_budget_source"],
  build(input: HandlerInput): ProposedAction {
    return agentProposal(input);
  },
};
