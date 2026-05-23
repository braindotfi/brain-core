import type { InternalAgentDefinition } from "@brain/schemas";

/** Vendor Risk (business, high-risk). Capability keccak256("vendor_risk"). */
export const vendorRiskDefinition: InternalAgentDefinition = {
  agent_key: "vendor_risk",
  display_name: "Vendor Risk",
  provenance: "internal",
  category: "business",
  capabilities: ["vendor_risk"],
  triggers: ["vendor.created", "vendor.bank_details_changed", "payment.destination_changed"],
  intent_patterns: ["check vendor risk", "review a new vendor", "verify a bank detail change"],
  readable_data: ["ledger:counterparties", "wiki:counterparty", "raw:evidence"],
  risk_level: "high",
  minimum_confidence: 0.8,
  required_evidence: ["vendor", "payment_destination", "counterparty_history"],
  default_authority: "propose",
  enabled_by_default: true,
  // High-risk: no default_action — max execution_mode is confirm/reject (INV-4).
  event_action_map: {
    "vendor.created": "flag_vendor_risk",
    "vendor.bank_details_changed": "flag_vendor_risk",
    "payment.destination_changed": "require_approval",
  },
};
