import {
  agentProposal,
  readString,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/** Bill Management actions. propose_payment / schedule_payment move money and go
 *  through IPaymentIntentService + the §6 gate; remind / alert are advisory. */
const FINANCIAL_ACTIONS = new Set(["propose_payment", "schedule_payment"]);

export const billManagementHandler: InternalAgentHandler = {
  agent_key: "bill_management",
  actions: ["remind", "propose_payment", "schedule_payment", "alert_late_fee_risk"],
  build(input: HandlerInput): ProposedAction {
    if (FINANCIAL_ACTIONS.has(input.action)) {
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
          ...(typeof c.invoice_id === "string" ? { invoice_id: c.invoice_id } : {}),
        },
      };
    }
    return agentProposal(input);
  },
};
