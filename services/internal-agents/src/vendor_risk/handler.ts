import {
  readString,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/**
 * Vendor Risk actions are non-financial proposals (flag, require approval,
 * block, escalate). When risk evidence (counterparty_history) backs a vendor
 * or destination change, a flag is escalated to a block_payment proposal.
 * High-risk: the policy template routes these to confirm/reject, never auto.
 */
export const vendorRiskHandler: InternalAgentHandler = {
  agent_key: "vendor_risk",
  actions: ["flag_vendor_risk", "require_approval", "block_payment", "escalate"],
  build(input: HandlerInput): ProposedAction {
    const hasRiskEvidence = input.evidence.items.some((i) => i.kind === "counterparty_history");
    // Escalate a flag to a payment block when risk evidence is present.
    const action =
      hasRiskEvidence && (input.action === "flag_vendor_risk" || input.action === "block_payment")
        ? "block_payment"
        : input.action;
    return {
      channel: "agent",
      action: {
        type: action,
        counterparty_id: readString(input.context.counterparty_id) || null,
        payment_destination: readString(input.context.payment_destination) || null,
        evidence_refs: input.evidence.items.map((i) => i.ref),
      },
    };
  },
};
