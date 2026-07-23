import type { InternalAgentDefinition } from "@brain/schemas";

/**
 * Reconciliation (agnostic). Capability keccak256("reconciliation_review").
 *
 * This is a NEW internal agent that brings reconciliation under the agent
 * pattern. It reads the Layer-2 reconciliation API (IReconciliationService)
 * via gathered evidence and proposes matches/discrepancy reviews through the
 * existing propose path. The deterministic Layer-2 ReconciliationService and
 * its routes are unchanged.
 */
export const reconciliationDefinition: InternalAgentDefinition = {
  agent_key: "reconciliation",
  display_name: "Reconciliation",
  provenance: "internal",
  category: "agnostic",
  capabilities: ["reconciliation_review"],
  triggers: [
    "transaction.unreconciled",
    "statement.imported",
    "reconciliation.candidate_found",
    "ledger.upload.projected",
  ],
  intent_patterns: [
    "reconcile transactions",
    "match statement to ledger",
    "resolve unreconciled transaction",
  ],
  readable_data: ["ledger:read"],
  risk_level: "low",
  minimum_confidence: 0.7,
  required_evidence: ["transaction"],
  default_authority: "propose",
  enabled_by_default: true,
  event_action_map: {
    "transaction.unreconciled": "propose_match",
    "statement.imported": "propose_match",
    "reconciliation.candidate_found": "propose_match",
    "ledger.upload.projected": "propose_match",
  },
  default_action: "propose_match",
};
