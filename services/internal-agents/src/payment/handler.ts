import {
  agentProposal,
  readString,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/**
 * Payment actions. The money-moving actions (propose_payment, schedule_payment,
 * execute_payment) go through IPaymentIntentService.create — and therefore
 * Policy + the §6 pre-execution gate. The agent never settles directly;
 * "execute_payment" means "propose an intent the gate will execute".
 * request_approval is advisory and goes through IAgentService.propose.
 */
const FINANCIAL_ACTIONS = new Set(["propose_payment", "schedule_payment", "execute_payment"]);

export const paymentHandler: InternalAgentHandler = {
  agent_key: "payment",
  actions: ["propose_payment", "schedule_payment", "request_approval", "execute_payment"],
  build(input: HandlerInput): ProposedAction {
    if (FINANCIAL_ACTIONS.has(input.action)) {
      const c = input.context;
      const isOnchain = readString(c.rail) === "onchain";
      return {
        channel: "payment_intent",
        intent: {
          action_type: isOnchain ? "onchain_transfer" : "ach_outbound",
          source_account_id: readString(c.source_account_id),
          destination_counterparty_id: readString(c.destination_counterparty_id),
          amount: readString(c.amount, "0"),
          currency: readString(c.currency, "USD"),
          confidence: input.evidence.evidence_score,
          evidence_ids: input.evidence.items.map((i) => i.ref),
          ...(typeof c.invoice_id === "string" ? { invoice_id: c.invoice_id } : {}),
        },
      };
    }
    return agentProposal(input);
  },
};
