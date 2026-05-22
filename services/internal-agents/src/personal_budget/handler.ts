import {
  agentProposal,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/** Personal Budget actions are advisory; all go through IAgentService.propose. */
export const personalBudgetHandler: InternalAgentHandler = {
  agent_key: "personal_budget",
  actions: [
    "categorize_spending",
    "recommend_budget_adjustment",
    "notify",
    "create_budget_summary",
  ],
  build(input: HandlerInput): ProposedAction {
    return agentProposal(input);
  },
};
