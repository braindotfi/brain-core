import type { InternalAgentDefinition } from "@brain/schemas";

/** Vendor Risk (business, high-risk). Capability keccak256("vendor_risk"). */
export const vendorRiskDefinition: InternalAgentDefinition = {
  agent_key: "vendor_risk",
  display_name: "Vendor Risk",
  provenance: "internal",
  category: "business",
  capabilities: ["vendor_risk"],
  triggers: [
    "vendor.created",
    "vendor.bank_details_changed",
    "payment.destination_changed",
    "ledger.upload.projected",
  ],
  intent_patterns: ["check vendor risk", "review a new vendor", "verify a bank detail change"],
  readable_data: ["ledger:read", "wiki:read", "raw:read"],
  risk_level: "high",
  minimum_confidence: 0.8,
  required_evidence: [
    { kind: "vendor", weight: 0.8, required: true },
    { kind: "payment_destination", weight: 0.1, required: false },
    { kind: "counterparty_history", weight: 0.1, required: false },
  ],
  default_authority: "propose",
  enabled_by_default: true,
  // High-risk: no default_action — max execution_mode is confirm/reject (INV-4).
  event_action_map: {
    "vendor.created": "flag_vendor_risk",
    "vendor.bank_details_changed": "flag_vendor_risk",
    "payment.destination_changed": "require_approval",
    "ledger.upload.projected": "flag_vendor_risk",
  },
};
