import type { EvidenceBundle } from "../src/evidence.js";
import type { GoldenScenario } from "./types.js";

const evidence: EvidenceBundle = {
  items: [{ kind: "balance", ref: "bal_eval_1", confidence: 0.95 }],
  completeness: 1,
  evidence_score: 0.95,
  missing_required_evidence: [],
  critical_missing: false,
};

export const cashForecastScenarios = [
  scenario(
    "clear surplus",
    "Reviewed cash forecast fixture: 80000 starting cash plus a 30000 receivable and only 10000 payable leaves every horizon above the 90000 surplus floor.",
    baseContext({
      current_balance: "80000.00",
      receivables: [receivable("inv_surplus", "30000.00", "2026-08-01")],
      payables: [payable("obl_surplus", "10000.00", "2026-08-10")],
      thresholds: { sweep_surplus_floor: "90000.00", operating_minimum: "10000.00" },
    }),
    {
      day_30: 100000,
      day_60: 100000,
      day_90: 100000,
      min_projected_balance: 80000,
      recommended_action: "sweep_surplus",
      shortfall_date: null,
    },
  ),
  scenario(
    "projected shortfall",
    "Reviewed cash forecast fixture: 100 starting cash minus a 250 payable due ten days out crosses below zero on 2026-07-28.",
    baseContext({
      current_balance: "100.00",
      receivables: [],
      payables: [payable("obl_shortfall", "250.00", "2026-07-28")],
    }),
    {
      day_30: -150,
      day_60: -150,
      day_90: -150,
      min_projected_balance: -150,
      recommended_action: "shortfall_alert",
      shortfall_date: "2026-07-28",
    },
  ),
  scenario(
    "flat no activity",
    "Reviewed cash forecast fixture: 5000 starting cash with no scheduled flows keeps every horizon flat and recommends hold.",
    baseContext({
      current_balance: "5000.00",
      receivables: [],
      payables: [],
    }),
    {
      day_30: 5000,
      day_60: 5000,
      day_90: 5000,
      min_projected_balance: 5000,
      recommended_action: "hold",
      shortfall_date: null,
    },
  ),
  scenario(
    "empty ledger zero",
    "Reviewed cash forecast fixture: a known zero balance and empty schedule is a valid empty ledger forecast, not missing evidence.",
    baseContext({
      current_balance: "0.00",
      receivables: [],
      payables: [],
    }),
    {
      day_30: 0,
      day_60: 0,
      day_90: 0,
      min_projected_balance: 0,
      recommended_action: "hold",
      shortfall_date: null,
    },
  ),
  scenario(
    "horizon boundary",
    "Reviewed cash forecast fixture: payables due exactly 30, 60, and 90 days from the fixed clock are included in those horizons.",
    baseContext({
      current_balance: "1000.00",
      receivables: [],
      payables: [
        payable("obl_30", "100.00", "2026-08-17"),
        payable("obl_60", "200.00", "2026-09-16"),
        payable("obl_90", "300.00", "2026-10-16"),
      ],
    }),
    {
      day_30: 900,
      day_60: 700,
      day_90: 400,
      min_projected_balance: 400,
      recommended_action: "hold",
      shortfall_date: null,
    },
  ),
  {
    agent_key: "cash_forecast",
    name: "missing balance evidence fails closed",
    rationale:
      "Reviewed fail-closed fixture: current balance is required to project net cash position, so the handler must hold instead of emitting a proposal.",
    input: {
      action: "generate_forecast",
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
  context: Record<string, unknown>,
  expected: {
    readonly day_30: number;
    readonly day_60: number;
    readonly day_90: number;
    readonly min_projected_balance: number;
    readonly recommended_action: string;
    readonly shortfall_date: string | null;
  },
): GoldenScenario {
  return {
    agent_key: "cash_forecast",
    name,
    rationale,
    input: {
      action: "generate_forecast",
      context,
      evidence,
    },
    expected: {
      projected_net_position: {
        day_30: expected.day_30,
        day_60: expected.day_60,
        day_90: expected.day_90,
      },
      min_projected_balance: expected.min_projected_balance,
      recommended_action: expected.recommended_action,
      shortfall_date: expected.shortfall_date,
    },
  };
}

function baseContext(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    balance_id: "bal_eval_1",
    current_balance: "1000.00",
    currency: "USD",
    receivables: [],
    payables: [],
    ...overrides,
  };
}

function receivable(invoiceId: string, amount: string, dueDate: string): Record<string, unknown> {
  return {
    invoice_id: invoiceId,
    amount,
    currency: "USD",
    due_date: dueDate,
    counterparty_id: "cp_eval_customer",
    counterparty_name: "Eval Customer",
  };
}

function payable(obligationId: string, amount: string, dueDate: string): Record<string, unknown> {
  return {
    obligation_id: obligationId,
    amount,
    currency: "USD",
    due_date: dueDate,
    counterparty_id: "cp_eval_vendor",
    counterparty_name: "Eval Vendor",
  };
}

function omit(input: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter((entry) => entry[0] !== key));
}
