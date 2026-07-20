import type { EvidenceBundle } from "../src/evidence.js";
import type { GoldenScenario } from "./types.js";

const evidence: EvidenceBundle = {
  items: [
    { kind: "obligation", ref: "obl_eval_payment_1", confidence: 0.95 },
    { kind: "counterparty", ref: "cp_eval_vendor", confidence: 0.95 },
    { kind: "payment_destination", ref: "dest_eval_vendor", confidence: 0.95 },
  ],
  completeness: 1,
  evidence_score: 0.95,
  missing_required_evidence: [],
  critical_missing: false,
};

export const paymentScenarios = [
  scenario(
    "due now payable",
    "Reviewed payment fixture: a payable due within two days should be ranked first and marked pay_now.",
    baseContext({
      payables: [
        payable("obl_eval_later", "200.00", "2026-08-20T00:00:00.000Z"),
        payable("obl_eval_now", "100.00", "2026-07-20T00:00:00.000Z"),
      ],
    }),
    {
      recommended_payment_decision: "pay_now",
      ranked_payables: [{ obligation_id: "obl_eval_now" }],
    },
  ),
  scenario(
    "defer far payable",
    "Reviewed payment fixture: a payable due beyond the near-term window with no discount should be deferred.",
    baseContext({
      obligation_id: "obl_eval_far",
      amount: "100.00",
      due_date: "2026-09-20T00:00:00.000Z",
    }),
    {
      recommended_payment_decision: "defer",
      ranked_payables: [{ obligation_id: "obl_eval_far" }],
    },
  ),
  scenario(
    "discount beats later bill",
    "Reviewed payment fixture: an expiring early-payment discount should rank above a later non-discount payable.",
    baseContext({
      payables: [
        payable("obl_eval_later", "200.00", "2026-08-20T00:00:00.000Z"),
        payable("obl_eval_discount", "1000.00", "2026-08-01T00:00:00.000Z", {
          discount_expires_at: "2026-07-21T00:00:00.000Z",
          discount_amount: "50.00",
        }),
      ],
    }),
    {
      recommended_payment_decision: "pay_now",
      ranked_payables: [{ obligation_id: "obl_eval_discount" }],
    },
  ),
  {
    agent_key: "payment",
    name: "missing payable fails closed",
    rationale:
      "Reviewed fail-closed fixture: payment advisory cannot prioritize approval without a payable obligation.",
    input: {
      action: "request_approval",
      context: omit(baseContext({}), "obligation_id"),
      evidence,
    },
    expected: {},
    expect_fail_closed: true,
  },
] as const satisfies readonly GoldenScenario[];

function scenario(
  name: string,
  rationale: string,
  context: Record<string, unknown>,
  expected: {
    readonly recommended_payment_decision: string;
    readonly ranked_payables: readonly Record<string, unknown>[];
  },
): GoldenScenario {
  return {
    agent_key: "payment",
    name,
    rationale,
    input: {
      action: "request_approval",
      context,
      evidence,
    },
    expected,
  };
}

function baseContext(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    source_account_id: "acct_eval_payment_1",
    currency: "USD",
    available_cash: "5000.00",
    obligation_id: "obl_eval_payment_1",
    counterparty_id: "cp_eval_vendor",
    counterparty_name: "Eval Vendor",
    amount: "100.00",
    due_date: "2026-07-25T00:00:00.000Z",
    payment_destination_id: "dest_eval_vendor",
    ...overrides,
  };
}

function payable(
  obligationId: string,
  amount: string,
  dueDate: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    obligation_id: obligationId,
    counterparty_id: "cp_eval_vendor",
    counterparty_name: "Eval Vendor",
    amount,
    currency: "USD",
    due_date: dueDate,
    ...overrides,
  };
}

function omit(input: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter((entry) => entry[0] !== key));
}
