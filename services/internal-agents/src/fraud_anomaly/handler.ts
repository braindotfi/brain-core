import {
  agentProposal,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/** Fraud & Anomaly actions (flag, notify, freeze card, draft dispute) are
 *  non-financial proposals; all go through IAgentService.propose. High-risk:
 *  the policy template routes them to confirm, never auto. */
export const fraudAnomalyHandler: InternalAgentHandler = {
  agent_key: "fraud_anomaly",
  actions: ["flag_transaction", "notify", "freeze_card", "create_dispute_draft"],
  build(input: HandlerInput): ProposedAction {
    return agentProposal(input);
  },
};
