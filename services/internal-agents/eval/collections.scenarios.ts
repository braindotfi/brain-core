import type { EvidenceBundle } from "../src/evidence.js";
import type { GoldenScenario } from "./types.js";

const evidence: EvidenceBundle = {
  items: [
    { kind: "invoice", ref: "inv_eval_1", confidence: 0.92 },
    { kind: "counterparty", ref: "cp_eval_1", confidence: 0.88 },
  ],
  completeness: 1,
  evidence_score: 0.88,
  missing_required_evidence: [],
  critical_missing: false,
};

export const collectionsScenarios = [
  tierScenario(1, "draft_followup", "draft_followup", "reminder", "1_14", [
    "draft_followup",
    "create_task",
    "escalate",
    "propose_payment_plan",
  ]),
  tierScenario(14, "draft_followup", "draft_followup", "reminder", "1_14", [
    "draft_followup",
    "create_task",
    "escalate",
    "propose_payment_plan",
  ]),
  tierScenario(15, "draft_followup", "create_task", "task", "15_29", [
    "create_task",
    "draft_followup",
    "escalate",
    "propose_payment_plan",
  ]),
  tierScenario(29, "draft_followup", "create_task", "task", "15_29", [
    "create_task",
    "draft_followup",
    "escalate",
    "propose_payment_plan",
  ]),
  tierScenario(30, "draft_followup", "escalate", "escalation", "30_59", [
    "escalate",
    "create_task",
    "propose_payment_plan",
    "draft_followup",
  ]),
  tierScenario(59, "draft_followup", "escalate", "escalation", "30_59", [
    "escalate",
    "create_task",
    "propose_payment_plan",
    "draft_followup",
  ]),
  tierScenario(60, "draft_followup", "propose_payment_plan", "payment_plan", "60_89", [
    "propose_payment_plan",
    "escalate",
    "create_task",
    "draft_followup",
  ]),
  tierScenario(89, "draft_followup", "propose_payment_plan", "payment_plan", "60_89", [
    "propose_payment_plan",
    "escalate",
    "create_task",
    "draft_followup",
  ]),
  tierScenario(90, "draft_followup", "propose_payment_plan", "payment_plan", "90_plus", [
    "propose_payment_plan",
    "escalate",
    "create_task",
    "draft_followup",
  ]),
  tierScenario(10, "escalate", "escalate", "escalation", "1_14", [
    "escalate",
    "draft_followup",
    "create_task",
    "propose_payment_plan",
  ]),
  tierScenario(5, "create_task", "create_task", "task", "1_14", [
    "create_task",
    "draft_followup",
    "escalate",
    "propose_payment_plan",
  ]),
  failClosedScenario("missing counterparty id", { counterparty_id: undefined }),
  failClosedScenario("missing amount", { amount: undefined }),
  failClosedScenario("zero days overdue", { days_overdue: 0 }),
] as const satisfies readonly GoldenScenario[];

function tierScenario(
  daysOverdue: number,
  action: string,
  recommendedAction: string,
  escalationTier: string,
  agingTier: string,
  rankedRecommendations: readonly string[],
): GoldenScenario {
  return {
    agent_key: "collections",
    name: `collections ${daysOverdue} days overdue via ${action}`,
    rationale:
      `Reviewed Collections threshold fixture: ${daysOverdue} days overdue with ${action} should map to ` +
      `${recommendedAction}, ${escalationTier}, and ${agingTier} under the shipped handler contract.`,
    input: {
      action,
      context: baseContext(daysOverdue),
      evidence,
    },
    expected: {
      recommended_action: recommendedAction,
      escalation_tier: escalationTier,
      aging_tier: agingTier,
      ranked_recommendations: rankedRecommendations,
    },
  };
}

function failClosedScenario(
  name: string,
  overrides: Readonly<Record<string, unknown>>,
): GoldenScenario {
  return {
    agent_key: "collections",
    name: `collections fail closed ${name}`,
    rationale: `Reviewed fail closed fixture: ${name} removes a required receivable field, so the handler must hold instead of emitting a proposal.`,
    input: {
      action: "draft_followup",
      context: withoutUndefined({ ...baseContext(18), ...overrides }),
      evidence,
    },
    expected: {},
    expect_fail_closed: true,
  };
}

function baseContext(daysOverdue: number): Record<string, unknown> {
  return {
    invoice_id: `inv_eval_${daysOverdue}`,
    counterparty_id: "cp_eval_1",
    counterparty_name: "Eval Customer",
    invoice_number: `INV-EVAL-${daysOverdue}`,
    amount: "1200.50",
    currency: "USD",
    due_date: "2026-06-01T00:00:00.000Z",
    days_overdue: daysOverdue,
  };
}

function withoutUndefined(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== undefined));
}
