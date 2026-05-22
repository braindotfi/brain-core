import {
  agentProposal,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/** Tax Prep actions are advisory (tag, summarize, request docs, export); all go
 *  through IAgentService.propose. */
export const taxPrepHandler: InternalAgentHandler = {
  agent_key: "tax_prep",
  actions: ["tag_tax_item", "create_tax_summary", "request_missing_evidence", "export_tax_packet"],
  build(input: HandlerInput): ProposedAction {
    return agentProposal(input);
  },
};
