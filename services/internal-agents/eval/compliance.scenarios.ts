import type { EvidenceBundle } from "../src/evidence.js";
import type { GoldenScenario } from "./types.js";

const evidence: EvidenceBundle = {
  items: [
    { kind: "policy_decision", ref: "pd_eval_compliance_1", confidence: 1 },
    { kind: "audit_event", ref: "evt_eval_compliance_1", confidence: 1 },
  ],
  completeness: 1,
  evidence_score: 1,
  missing_required_evidence: [],
  critical_missing: false,
};

export const complianceScenarios = [
  scenario(
    "genuine missing approval violation",
    "Reviewed compliance fixture: a movement with a confirm policy decision and no valid approval is a governance violation.",
    baseContext({
      finding_type: "approval_missing",
      severity: "medium",
      required_approvers_count: 1,
      valid_approval_count: 0,
      payment_intent_id: "pi_eval_missing",
    }),
    { expected_violation: true },
  ),
  scenario(
    "fully compliant movement",
    "Reviewed compliance fixture: a movement with required approval satisfied should not emit a violation label.",
    baseContext({
      finding_type: "no_finding",
      severity: "info",
      required_approvers_count: 1,
      valid_approval_count: 1,
      payment_intent_id: "pi_eval_compliant",
    }),
    { expected_violation: false },
  ),
  scenario(
    "stale approval remains a violation",
    "Reviewed compliance fixture: a stale approval is present but does not count as valid approval for the movement.",
    baseContext({
      finding_type: "approval_missing",
      severity: "medium",
      required_approvers_count: 1,
      valid_approval_count: 0,
      stale_approval_count: 1,
      payment_intent_id: "pi_eval_stale",
    }),
    { expected_violation: true },
  ),
  {
    agent_key: "compliance",
    name: "missing required evidence fails closed",
    rationale:
      "Reviewed fail-closed fixture: the compliance agent must not classify without both policy_decision and audit_event evidence.",
    input: {
      action: "notify",
      context: {
        finding_type: "approval_missing",
        policy_decision_id: "pd_eval_missing_evidence",
      },
      evidence: {
        items: [{ kind: "policy_decision", ref: "pd_eval_missing_evidence", confidence: 1 }],
        completeness: 0.5,
        evidence_score: 0.5,
        missing_required_evidence: ["audit_event"],
        critical_missing: true,
      },
    },
    expected: { expected_violation: true },
    expect_fail_closed: true,
  },
] as const satisfies readonly GoldenScenario[];

function scenario(
  name: string,
  rationale: string,
  context: Record<string, unknown>,
  expected: { readonly expected_violation: boolean },
): GoldenScenario {
  return {
    agent_key: "compliance",
    name,
    rationale,
    input: {
      action: "escalate",
      context,
      evidence,
    },
    expected,
  };
}

function baseContext(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    policy_decision_id: "pd_eval_compliance_1",
    audit_event_id: "evt_eval_compliance_1",
    policy_outcome: "confirm",
    subject_type: "payment_intent",
    subject_id: "pi_eval_compliance_1",
    rule_id: "cmp_missing_approval",
    ...overrides,
  };
}
