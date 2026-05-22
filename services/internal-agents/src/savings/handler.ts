import {
  agentProposal,
  readString,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/** Savings actions. `propose_transfer` moves money to a savings account and goes
 *  through IPaymentIntentService + the §6 gate; the rest are advisory. */
export const savingsHandler: InternalAgentHandler = {
  agent_key: "savings",
  actions: ["recommend_savings_transfer", "propose_transfer", "update_goal_progress", "notify"],
  build(input: HandlerInput): ProposedAction {
    if (input.action === "propose_transfer") {
      const c = input.context;
      return {
        channel: "payment_intent",
        intent: {
          action_type: "ach_outbound",
          source_account_id: readString(c.source_account_id),
          destination_counterparty_id: readString(c.destination_counterparty_id),
          amount: readString(c.amount, "0"),
          currency: readString(c.currency, "USD"),
          evidence_ids: input.evidence.items.map((i) => i.ref),
        },
      };
    }
    return agentProposal(input);
  },
};
