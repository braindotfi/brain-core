import type { InternalAgentDefinition } from "@brain/schemas";

/** Payment (business). Capability keccak256("payment_propose"). */
export const paymentDefinition: InternalAgentDefinition = {
  agent_key: "payment",
  display_name: "Payment",
  provenance: "internal",
  category: "business",
  capabilities: ["payment_propose"],
  triggers: ["bill.due_soon", "invoice.approved", "payment.scheduled"],
  intent_patterns: ["pay this bill", "schedule a payment", "approve and pay invoice"],
  readable_data: [
    "ledger:invoices",
    "ledger:counterparties",
    "ledger:accounts",
    "ledger:obligations",
  ],
  risk_level: "medium",
  minimum_confidence: 0.85,
  required_evidence: ["invoice", "counterparty", "payment_destination"],
  default_authority: "propose",
  enabled_by_default: true,
};
