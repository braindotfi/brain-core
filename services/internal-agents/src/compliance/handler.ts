import {
  agentProposal,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/** Compliance actions notify, escalate, block, or report; none move money, so
 *  all go through IAgentService.propose. High-risk: never auto-executes. */
export const complianceHandler: InternalAgentHandler = {
  agent_key: "compliance",
  actions: ["notify", "escalate", "block_action", "create_compliance_report"],
  build(input: HandlerInput): ProposedAction {
    return agentProposal(input);
  },
};
