import type { InternalAgentDefinition } from "@brain/schemas";

/** Collections (business). Capability keccak256("collections_followup"). */
export const collectionsDefinition: InternalAgentDefinition = {
  agent_key: "collections",
  display_name: "Collections",
  provenance: "internal",
  category: "business",
  capabilities: ["collections_followup"],
  triggers: [
    "invoice.overdue",
    "payment.failed",
    "receivable.aging_threshold_crossed",
    "ledger.upload.projected",
  ],
  intent_patterns: [
    "follow up on overdue invoice",
    "chase late payment",
    "remind customer about unpaid invoice",
  ],
  readable_data: ["ledger:read", "wiki:read"],
  risk_level: "medium",
  minimum_confidence: 0.75,
  required_evidence: ["invoice", "counterparty"],
  default_authority: "propose",
  enabled_by_default: true,
  event_action_map: {
    "invoice.overdue": "draft_followup",
    "payment.failed": "escalate",
    "receivable.aging_threshold_crossed": "create_task",
    "ledger.upload.projected": "draft_followup",
  },
  default_action: "draft_followup",
};
