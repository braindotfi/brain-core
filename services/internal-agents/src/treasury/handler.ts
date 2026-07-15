import {
  agentProposal,
  requireCurrency,
  requireDecimalAmount,
  requireStringField,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/**
 * Treasury actions. `propose_transfer` moves money, so it goes through
 * IPaymentIntentService.create (and thus Policy + the §6 gate). The rest are
 * advisory and go through IAgentService.propose.
 */
export const treasuryHandler: InternalAgentHandler = {
  agent_key: "treasury",
  actions: [
    "recommend_cash_sweep",
    "propose_transfer",
    "alert_low_balance",
    "create_liquidity_plan",
  ],
  build(input: HandlerInput): ProposedAction {
    if (input.action === "propose_transfer") {
      const c = input.context;
      return {
        channel: "payment_intent",
        intent: {
          action_type: "onchain_transfer",
          source_account_id: requireStringField(c, "source_account_id"),
          destination_counterparty_id: requireStringField(c, "destination_counterparty_id"),
          amount: requireDecimalAmount(c, "amount"),
          currency: requireCurrency(c, "currency"),
          confidence: input.evidence.evidence_score,
          evidence_ids: input.evidence.items.map((i) => i.ref),
        },
      };
    }
    return agentProposal(input);
  },
};
