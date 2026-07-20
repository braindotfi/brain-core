import type { EvidenceBundle } from "../src/evidence.js";
import type { GoldenScenario } from "./types.js";

const evidence: EvidenceBundle = {
  items: [{ kind: "balance", ref: "bal_eval_treasury_1", confidence: 0.95 }],
  completeness: 1,
  evidence_score: 0.95,
  missing_required_evidence: [],
  critical_missing: false,
};

export const treasuryScenarios = [
  scenario(
    "surplus cash sweep",
    "Reviewed treasury fixture: 120000 cash with a 50000 operating minimum leaves 70000 advisory sweep capacity.",
    "recommend_cash_sweep",
    baseContext({
      current_balance: "120000.00",
      thresholds: {
        operating_minimum: "50000.00",
        surplus_floor: "100000.00",
        low_balance_floor: "25000.00",
      },
    }),
    { sweep_amount: 70000, recommended_action: "recommend_cash_sweep" },
  ),
  scenario(
    "low balance alert",
    "Reviewed treasury fixture: 10000 cash is below the 25000 low-balance floor and must notify for liquidity review.",
    "alert_low_balance",
    baseContext({
      current_balance: "10000.00",
      thresholds: {
        operating_minimum: "50000.00",
        surplus_floor: "100000.00",
        low_balance_floor: "25000.00",
      },
    }),
    { sweep_amount: 0, recommended_action: "alert_low_balance" },
  ),
  scenario(
    "liquidity plan middle band",
    "Reviewed treasury fixture: 60000 cash is above low-balance floor but below surplus floor, so no sweep is recommended.",
    "create_liquidity_plan",
    baseContext({
      current_balance: "60000.00",
      thresholds: {
        operating_minimum: "50000.00",
        surplus_floor: "100000.00",
        low_balance_floor: "25000.00",
      },
    }),
    { sweep_amount: 0, recommended_action: "create_liquidity_plan" },
  ),
  {
    agent_key: "treasury",
    name: "missing balance fails closed",
    rationale:
      "Reviewed fail-closed fixture: treasury advisory requires current balance evidence and must not fabricate sweep capacity.",
    input: {
      action: "recommend_cash_sweep",
      context: omit(baseContext({}), "current_balance"),
      evidence,
    },
    expected: {},
    expect_fail_closed: true,
  },
] as const satisfies readonly GoldenScenario[];

function scenario(
  name: string,
  rationale: string,
  action: string,
  context: Record<string, unknown>,
  expected: { readonly sweep_amount: number; readonly recommended_action: string },
): GoldenScenario {
  return {
    agent_key: "treasury",
    name,
    rationale,
    input: {
      action,
      context,
      evidence,
    },
    expected,
  };
}

function baseContext(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    balance_id: "bal_eval_treasury_1",
    account_id: "acct_eval_treasury_1",
    current_balance: "50000.00",
    currency: "USD",
    ...overrides,
  };
}

function omit(input: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter((entry) => entry[0] !== key));
}
