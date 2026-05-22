import {
  agentProposal,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/** Revenue Intelligence actions recommend, flag, and summarize; none move money,
 *  so all go through IAgentService.propose. */
export const revenueIntelHandler: InternalAgentHandler = {
  agent_key: "revenue_intel",
  actions: [
    "recommend_follow_up",
    "flag_churn_risk",
    "identify_expansion_opportunity",
    "create_revenue_summary",
  ],
  build(input: HandlerInput): ProposedAction {
    return agentProposal(input);
  },
};
