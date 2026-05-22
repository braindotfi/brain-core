import {
  agentProposal,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/** Dispute actions assemble evidence and draft responses; none move money, so
 *  all go through IAgentService.propose. Evidence refs (Wiki + Raw) ride along. */
export const disputeHandler: InternalAgentHandler = {
  agent_key: "dispute",
  actions: ["gather_evidence", "draft_response", "escalate", "create_dispute_packet"],
  build(input: HandlerInput): ProposedAction {
    return agentProposal(input);
  },
};
