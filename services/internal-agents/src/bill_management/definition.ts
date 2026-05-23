import type { InternalAgentDefinition } from "@brain/schemas";

/** Bill Management (consumer). Capability keccak256("bill_management"). Shares
 *  bill.due_soon with the business Payment agent; category-aware routing decides. */
export const billManagementDefinition: InternalAgentDefinition = {
  agent_key: "bill_management",
  display_name: "Bill Management",
  provenance: "internal",
  category: "consumer",
  capabilities: ["bill_management"],
  triggers: ["bill.due_soon", "bill.overdue", "autopay.failed"],
  intent_patterns: ["pay my bill", "remind me about bills", "avoid late fees"],
  readable_data: ["ledger:obligations", "ledger:invoices", "ledger:accounts"],
  risk_level: "medium",
  minimum_confidence: 0.8,
  required_evidence: ["invoice", "payment_destination"],
  default_authority: "notify_only",
  enabled_by_default: true,
  // Money-mover: no default_action — financial actions require an explicit/event match.
  event_action_map: {
    "bill.due_soon": "remind",
    "bill.overdue": "alert_late_fee_risk",
    "autopay.failed": "alert_late_fee_risk",
  },
};
