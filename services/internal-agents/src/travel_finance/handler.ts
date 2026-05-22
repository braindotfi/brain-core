import {
  agentProposal,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/** Travel Finance actions are advisory (recommend card, flag fee, summarize);
 *  all go through IAgentService.propose. */
export const travelFinanceHandler: InternalAgentHandler = {
  agent_key: "travel_finance",
  actions: ["recommend_card", "flag_fee", "create_trip_spend_summary", "notify"],
  build(input: HandlerInput): ProposedAction {
    return agentProposal(input);
  },
};
