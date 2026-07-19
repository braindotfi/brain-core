import type { EvidenceBundle } from "../src/evidence.js";
import type { GoldenScenario } from "./types.js";

const evidence: EvidenceBundle = {
  items: [
    { kind: "dispute", ref: "dsp_eval_1", confidence: 0.95 },
    { kind: "transaction", ref: "tx_eval_dispute_1", confidence: 0.95 },
  ],
  completeness: 1,
  evidence_score: 0.95,
  missing_required_evidence: [],
  critical_missing: false,
};

export const disputeScenarios = [
  scenario(
    "small old dispute accepts",
    "Reviewed dispute fixture: a small old dispute with complete evidence costs more to contest than accept.",
    baseContext({ amount: "50.00", dispute_age_days: 60, evidence_completeness: 1 }),
    { recommended_action: "accept", evidence_completeness: 1 },
  ),
  scenario(
    "large complete dispute contests",
    "Reviewed dispute fixture: a large chargeback with complete evidence should be contested.",
    baseContext({ amount: "750.00", dispute_age_days: 7, evidence_completeness: 0.95 }),
    { recommended_action: "contest", evidence_completeness: 0.95 },
  ),
  scenario(
    "incomplete evidence gathers",
    "Reviewed dispute fixture: incomplete supporting evidence must be gathered before a final response.",
    baseContext({ amount: "750.00", dispute_age_days: 7, evidence_completeness: 0.4 }),
    { recommended_action: "gather_evidence", evidence_completeness: 0.4 },
  ),
  scenario(
    "deadline imminent gathers",
    "Reviewed dispute fixture: an imminent deadline prioritizes evidence gathering even when the amount is large.",
    baseContext({
      amount: "750.00",
      deadline: "2026-07-20",
      dispute_age_days: 7,
      evidence_completeness: 0.95,
    }),
    { recommended_action: "gather_evidence", evidence_completeness: 0.95 },
  ),
  {
    agent_key: "dispute",
    name: "missing transaction evidence fails closed",
    rationale:
      "Reviewed fail-closed fixture: a dispute recommendation without linked transaction evidence would fabricate grounding.",
    input: {
      action: "gather_evidence",
      context: baseContext({ transaction_id: "tx_eval_missing" }),
      evidence: {
        items: [{ kind: "dispute", ref: "dsp_eval_missing", confidence: 1 }],
        completeness: 0.5,
        evidence_score: 0.5,
        missing_required_evidence: ["transaction"],
        critical_missing: true,
      },
    },
    expected: { recommended_action: "gather_evidence", evidence_completeness: 0.5 },
    expect_fail_closed: true,
  },
] as const satisfies readonly GoldenScenario[];

function scenario(
  name: string,
  rationale: string,
  context: Record<string, unknown>,
  expected: { readonly recommended_action: string; readonly evidence_completeness: number },
): GoldenScenario {
  return {
    agent_key: "dispute",
    name,
    rationale,
    input: {
      action: "gather_evidence",
      context,
      evidence,
    },
    expected,
  };
}

function baseContext(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    dispute_id: "dsp_eval_1",
    transaction_id: "tx_eval_dispute_1",
    amount: "250.00",
    currency: "USD",
    deadline: "2026-07-25",
    dispute_age_days: 7,
    evidence_completeness: 1,
    ...overrides,
  };
}
