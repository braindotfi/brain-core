import type { InternalAgentDefinition } from "@brain/schemas";

/** Tax Prep (consumer). Capability keccak256("tax_prep"). */
export const taxPrepDefinition: InternalAgentDefinition = {
  agent_key: "tax_prep",
  display_name: "Tax Prep",
  provenance: "internal",
  category: "consumer",
  capabilities: ["tax_prep"],
  triggers: ["tax_category.detected", "year_end.approaching", "document.uploaded"],
  intent_patterns: ["prepare my taxes", "tag tax deductions", "what do i need for taxes"],
  readable_data: ["ledger:read", "raw:read", "wiki:read"],
  risk_level: "low",
  minimum_confidence: 0.7,
  required_evidence: ["transaction"],
  default_authority: "propose",
  enabled_by_default: true,
  event_action_map: {
    "tax_category.detected": "tag_tax_item",
    "year_end.approaching": "create_tax_summary",
    "document.uploaded": "tag_tax_item",
  },
  default_action: "tag_tax_item",
};
