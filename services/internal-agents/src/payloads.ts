/**
 * Workflow-specific handler payloads for registered agents (Agent Autonomy v3, 2.1).
 *
 * agentProposal() stays the shared fallback. This registry is the typed contract
 * for each agent's proposal payload: the required fields the plan enumerates per
 * agent. validateAgentPayload enforces it before a proposal is recorded.
 *
 * NOTE(agent-autonomy-v3): this TS registry is the source of truth; emitting
 * per-agent JSON Schemas under schemas/agent-payloads/<agent_id>.json (generated
 * from this registry) and wiring every handler to populate its typed payload are
 * mechanical follow-ups.
 */

export const AGENT_PAYLOAD_REQUIRED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // Business
  collections: [
    "decision_context",
    "invoice_id",
    "counterparty_id",
    "amount_due",
    "days_overdue",
    "recommended_tone",
    "draft_message",
    "next_escalation_date",
    "evidence_refs",
  ],
  treasury: [
    "decision_context",
    "source_account_id",
    "target_account_id",
    "available_cash",
    "minimum_operating_cash",
    "recommended_transfer",
    "liquidity_risk",
    "expected_yield",
    "evidence_refs",
  ],
  payment: [
    "decision_context",
    "amount",
    "currency",
    "source_account_id",
    "destination_counterparty_id",
    "due_date",
    "evidence_refs",
  ],
  vendor_risk: [
    "decision_context",
    "vendor_id",
    "changed_field",
    "previous_value_hash",
    "new_value_hash",
    "risk_reason",
    "recommended_action",
    "evidence_refs",
  ],
  cash_forecast: [
    "decision_context",
    "period_start",
    "period_end",
    "projected_inflows",
    "projected_outflows",
    "net_position",
    "confidence_band",
    "evidence_refs",
  ],
  dispute: [
    "decision_context",
    "transaction_id",
    "dispute_reason",
    "evidence_bundle",
    "recommended_action",
    "evidence_refs",
  ],
  compliance: [
    "rule_id",
    "finding_kind",
    "severity",
    "affected_entities",
    "recommended_remediation",
    "evidence_refs",
  ],
  aml_compliance: [
    "decision_context",
    "payment_id",
    "beneficiary_id",
    "amount",
    "currency",
    "jurisdictions_involved",
    "screenings",
    "required_documents",
    "regulatory_context",
    "recommended_action",
    "deadline",
    "evidence_refs",
  ],
  revenue_intel: [
    "decision_context",
    "period",
    "segment",
    "top_movers",
    "anomalies",
    "forecast_adjustments",
    "evidence_refs",
  ],
  // Consumer
  personal_budget: [
    "period",
    "category_targets",
    "current_spend",
    "projected_overage",
    "recommended_actions",
    "evidence_refs",
  ],
  bill_management: [
    "obligation_id",
    "due_date",
    "amount",
    "source_account_id",
    "recommended_action",
    "evidence_refs",
  ],
  savings: [
    "source_account_id",
    "target_account_id",
    "recommended_amount",
    "sweep_trigger",
    "evidence_refs",
  ],
  debt_optimization: [
    "debt_accounts",
    "recommended_payment_distribution",
    "expected_interest_savings",
    "evidence_refs",
  ],
  tax_prep: [
    "tax_year",
    "estimated_liability",
    "deduction_candidates",
    "missing_documents",
    "evidence_refs",
  ],
  travel_finance: [
    "trip_id",
    "budget",
    "projected_spend",
    "currency_exposure",
    "recommended_actions",
    "evidence_refs",
  ],
  financial_health: ["score", "trend", "key_drivers", "recommended_actions", "evidence_refs"],
  purchase_advisor: ["intent", "options", "recommended_option", "total_cost", "evidence_refs"],
  // Agnostic
  subscription: [
    "merchant",
    "recurring_amount",
    "billing_frequency",
    "duplicate_candidates",
    "recommended_action",
    "estimated_savings",
    "evidence_refs",
  ],
  subscription_management: [
    "decision_context",
    "subscription_id",
    "merchant",
    "current_plan",
    "renewal_date",
    "currency",
    "current_price",
    "options",
    "recommended_action",
    "evidence_refs",
  ],
  reconciliation: [
    "decision_context",
    "match_type",
    "left_entity_id",
    "right_entity_id",
    "confidence_score",
    "explanation",
    "evidence_refs",
  ],
  fraud_anomaly: [
    "decision_context",
    "transaction_id",
    "anomaly_type",
    "anomaly_score",
    "recommended_action",
    "evidence_refs",
  ],
  invoice_integrity: [
    "decision_context",
    "obligation_id",
    "finding_type",
    "amount",
    "currency",
    "evidence_refs",
  ],
};

export interface AgentPayloadValidation {
  readonly ok: boolean;
  readonly missing: readonly string[];
}

/**
 * Validate a workflow payload for `agentKey` against its required fields. An
 * agent with no registered payload contract is treated as ok (uses the
 * agentProposal fallback shape).
 */
export function validateAgentPayload(
  agentKey: string,
  payload: Record<string, unknown>,
): AgentPayloadValidation {
  const required = AGENT_PAYLOAD_REQUIRED_FIELDS[agentKey];
  if (required === undefined) {
    return { ok: true, missing: [] };
  }
  const missing = required.filter((f) => payload[f] === undefined);
  return { ok: missing.length === 0, missing };
}
