import type { InternalAgentDefinition } from "@brain/schemas";

/** Invoice Integrity (business, high-risk). Capability keccak256("invoice_integrity").
 *  Flags fraud/compliance-shaped anomalies on uploaded, unpaid obligations
 *  (AP/AR invoices, tax obligations) before they're ever paid - the layer
 *  fraud_anomaly (settled transactions), vendor_risk (existing counterparty
 *  identity), and compliance (payment-intent policy/audit trail) don't cover. */
export const invoiceIntegrityDefinition: InternalAgentDefinition = {
  agent_key: "invoice_integrity",
  display_name: "Invoice Integrity",
  provenance: "internal",
  category: "business",
  capabilities: ["invoice_integrity"],
  triggers: [
    "obligation.duplicate_suspected",
    "obligation.structuring_suspected",
    "obligation.threshold_avoidance_suspected",
    "obligation.high_value_new_vendor",
  ],
  intent_patterns: [
    "check this invoice for duplicates",
    "is this a duplicate invoice",
    "review this obligation for risk",
  ],
  readable_data: ["ledger:read", "wiki:read"],
  risk_level: "high",
  minimum_confidence: 0.8,
  required_evidence: ["obligation"],
  default_authority: "notify_only",
  enabled_by_default: true,
  // High-risk: no default_action - max execution_mode is confirm/reject (INV-4).
  event_action_map: {
    "obligation.duplicate_suspected": "flag_duplicate_invoice",
    "obligation.structuring_suspected": "flag_structuring",
    "obligation.threshold_avoidance_suspected": "flag_threshold_avoidance",
    "obligation.high_value_new_vendor": "flag_unverified_vendor",
  },
};
