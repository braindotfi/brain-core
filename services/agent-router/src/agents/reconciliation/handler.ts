import {
  agentProposal,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/** Reconciliation actions are non-financial proposals over Ledger reconciliation
 *  candidates; they go through IAgentService.propose. No money moves. */
export const reconciliationHandler: InternalAgentHandler = {
  agent_key: "reconciliation",
  actions: ["propose_match", "flag_discrepancy", "create_task"],
  build(input: HandlerInput): ProposedAction {
    return agentProposal(input);
  },
};
