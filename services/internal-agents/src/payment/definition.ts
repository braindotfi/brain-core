import type { InternalAgentDefinition } from "@brain/schemas";

/** Payment (business). Capability keccak256("payment_propose"). */
export const paymentDefinition: InternalAgentDefinition = {
  agent_key: "payment",
  display_name: "Payment",
  provenance: "internal",
  category: "business",
  capabilities: ["payment_propose"],
  triggers: [
    "bill.due_soon",
    "invoice.approved",
    "payment.scheduled",
    "payable.due_soon",
    "payable.discount_expiring",
  ],
  intent_patterns: ["pay this bill", "schedule a payment", "approve and pay invoice"],
  readable_data: ["ledger:read"],
  risk_level: "medium",
  minimum_confidence: 0.85,
  required_evidence: ["obligation", "counterparty", "payment_destination"],
  default_authority: "propose",
  enabled_by_default: true,
  // Money-mover: no default_action — financial actions require an explicit/event match.
  event_action_map: {
    "bill.due_soon": "propose_payment",
    "invoice.approved": "propose_payment",
    "payment.scheduled": "schedule_payment",
    "payable.due_soon": "request_approval",
    "payable.discount_expiring": "request_approval",
  },
};
