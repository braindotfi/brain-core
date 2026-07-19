import type { EvidenceBundle } from "../src/evidence.js";
import type { GoldenScenario } from "./types.js";

const evidence: EvidenceBundle = {
  items: [{ kind: "transaction", ref: "tx_eval_sub_current", confidence: 0.95 }],
  completeness: 1,
  evidence_score: 0.95,
  missing_required_evidence: [],
  critical_missing: false,
};

export const subscriptionScenarios = [
  scenario(
    "clear recurring subscription",
    "Reviewed subscription fixture: three monthly same-counterparty charges with stable amount should be detected.",
    baseContext({
      amount: "100.00",
      transaction_date: "2026-06-16",
      history: monthlyHistory("100.00"),
    }),
    {
      expected_subscription: true,
      recommended_action: "flag_subscription",
      cadence: "monthly",
    },
  ),
  scenario(
    "one-off not flagged",
    "Reviewed subscription fixture: irregular historical charge spacing must not be flagged as a subscription.",
    baseContext({
      amount: "100.00",
      transaction_date: "2026-06-16",
      history: [
        charge("tx_eval_sub_1", "100.00", "2026-01-01"),
        charge("tx_eval_sub_2", "100.00", "2026-02-20"),
        charge("tx_eval_sub_current", "100.00", "2026-06-16"),
      ],
    }),
    {
      expected_subscription: false,
      recommended_action: "monitor",
      cadence: null,
    },
  ),
  scenario(
    "irregular cadence edge",
    "Reviewed subscription fixture: three charges that are close but outside the monthly cadence tolerance stay unflagged.",
    baseContext({
      amount: "100.00",
      transaction_date: "2026-06-16",
      history: [
        charge("tx_eval_sub_1", "100.00", "2026-04-01"),
        charge("tx_eval_sub_2", "100.00", "2026-04-20"),
        charge("tx_eval_sub_current", "100.00", "2026-06-16"),
      ],
    }),
    {
      expected_subscription: false,
      recommended_action: "monitor",
      cadence: null,
    },
  ),
  scenario(
    "price change review",
    "Reviewed subscription fixture: a regular monthly charge with a material price jump should be reviewed.",
    baseContext({
      amount: "130.00",
      transaction_date: "2026-06-16",
      history: monthlyHistory("130.00"),
    }),
    {
      expected_subscription: true,
      recommended_action: "review_price_change",
      cadence: "monthly",
    },
  ),
  {
    agent_key: "subscription",
    name: "insufficient history fails closed",
    rationale:
      "Reviewed fail-closed fixture: fewer than three charges cannot prove recurrence and must not be flagged.",
    input: {
      action: "flag_subscription",
      context: baseContext({
        history: [
          charge("tx_eval_sub_1", "100.00", "2026-05-17"),
          charge("tx_eval_sub_current", "100.00", "2026-06-16"),
        ],
      }),
      evidence,
    },
    expected: {
      expected_subscription: false,
      recommended_action: "monitor",
      cadence: null,
    },
    expect_fail_closed: true,
  },
] as const satisfies readonly GoldenScenario[];

function scenario(
  name: string,
  rationale: string,
  context: Record<string, unknown>,
  expected: Readonly<Record<string, unknown>>,
): GoldenScenario {
  return {
    agent_key: "subscription",
    name,
    rationale,
    input: {
      action: "flag_subscription",
      context,
      evidence,
    },
    expected,
  };
}

function baseContext(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    transaction_id: "tx_eval_sub_current",
    counterparty_id: "cp_eval_sub",
    amount: "100.00",
    currency: "USD",
    transaction_date: "2026-06-16",
    history: monthlyHistory("100.00"),
    ...overrides,
  };
}

function monthlyHistory(currentAmount: string): readonly Record<string, unknown>[] {
  return [
    charge("tx_eval_sub_1", "100.00", "2026-04-17"),
    charge("tx_eval_sub_2", "100.00", "2026-05-17"),
    charge("tx_eval_sub_current", currentAmount, "2026-06-16"),
  ];
}

function charge(
  transactionId: string,
  amount: string,
  transactionDate: string,
): Record<string, unknown> {
  return { transaction_id: transactionId, amount, transaction_date: transactionDate };
}
