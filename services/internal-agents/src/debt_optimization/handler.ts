import {
  agentProposal,
  readString,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/** Debt Optimization actions. propose_payment moves money (gate); the rest are advisory. */
export const debtOptimizationHandler: InternalAgentHandler = {
  agent_key: "debt_optimization",
  actions: ["recommend_paydown", "propose_payment", "create_debt_plan", "notify"],
  build(input: HandlerInput): ProposedAction {
    if (input.action === "propose_payment") {
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
