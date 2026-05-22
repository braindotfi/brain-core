import {
  agentProposal,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/** Subscription actions are advisory (flag, recommend, draft, report); none move
 *  money, so all go through IAgentService.propose. */
export const subscriptionHandler: InternalAgentHandler = {
  agent_key: "subscription",
  actions: ["flag_subscription", "recommend_cancel", "draft_vendor_email", "create_savings_report"],
  build(input: HandlerInput): ProposedAction {
    return agentProposal(input);
  },
};
