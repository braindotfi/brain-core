import {
  agentProposal,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/** Collections actions are non-financial: they draft, send, task, escalate, or
 *  propose a payment plan. None move money, so all go through IAgentService. */
export const collectionsHandler: InternalAgentHandler = {
  agent_key: "collections",
  actions: ["draft_followup", "send_followup", "create_task", "escalate", "propose_payment_plan"],
  build(input: HandlerInput): ProposedAction {
    return agentProposal(input);
  },
};
