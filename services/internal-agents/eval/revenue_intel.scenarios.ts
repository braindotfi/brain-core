import type { EvidenceBundle } from "../src/evidence.js";
import type { GoldenScenario } from "./types.js";

const evidence: EvidenceBundle = {
  items: [
    { kind: "invoice", ref: "inv_eval_revenue_1", confidence: 0.95 },
    { kind: "transaction", ref: "tx_eval_revenue_1", confidence: 0.95 },
  ],
  completeness: 1,
  evidence_score: 0.95,
  missing_required_evidence: [],
  critical_missing: false,
};

export const revenueIntelScenarios = [
  scenario(
    "revenue up healthy",
    "Reviewed revenue fixture: current-period revenue 1200 versus 1000 is a 20 percent increase with no customer risk.",
    baseContext({
      current_period_revenue: "1200.00",
      prior_period_revenue: "1000.00",
      current_dso: 20,
      prior_dso: 18,
    }),
    expected({ delta: 200, percent: 20, trend: "up", dsoDelta: 2, riskCount: 0, renewalCount: 0 }),
  ),
  scenario(
    "revenue down",
    "Reviewed revenue fixture: current-period revenue 900 versus 1000 is a 10 percent decline.",
    baseContext({
      current_period_revenue: "900.00",
      prior_period_revenue: "1000.00",
      current_dso: 22,
      prior_dso: 20,
    }),
    expected({
      delta: -100,
      percent: -10,
      trend: "down",
      dsoDelta: 2,
      riskCount: 0,
      renewalCount: 0,
    }),
  ),
  scenario(
    "flat revenue",
    "Reviewed revenue fixture: a 2 percent change is categorized flat under the five percent materiality band.",
    baseContext({
      current_period_revenue: "1020.00",
      prior_period_revenue: "1000.00",
      current_dso: 20,
      prior_dso: 20,
    }),
    expected({ delta: 20, percent: 2, trend: "flat", dsoDelta: 0, riskCount: 0, renewalCount: 0 }),
  ),
  scenario(
    "worsened DSO flags customer risk",
    "Reviewed revenue fixture: DSO worsening by at least 10 days creates a payment-behavior risk flag.",
    baseContext({
      current_period_revenue: "1000.00",
      prior_period_revenue: "1000.00",
      current_dso: 38,
      prior_dso: 20,
    }),
    expected({ delta: 0, percent: 0, trend: "flat", dsoDelta: 18, riskCount: 1, renewalCount: 0 }),
  ),
  scenario(
    "upcoming renewal is carried",
    "Reviewed revenue fixture: an explicit upcoming renewal should be reported without fabricating a revenue trend.",
    baseContext({
      upcoming_renewals: [{ counterparty_id: "cp_eval_revenue", renewal_date: "2026-08-01" }],
    }),
    expected({ delta: 0, percent: 0, trend: "flat", dsoDelta: 0, riskCount: 0, renewalCount: 1 }),
  ),
  {
    agent_key: "revenue_intel",
    name: "empty period fails closed",
    rationale:
      "Reviewed fail-closed fixture: revenue intelligence without invoice and transaction evidence would invent period metrics.",
    input: {
      action: "create_revenue_summary",
      context: { invoice_id: "inv_eval_empty", transaction_id: "tx_eval_empty" },
      evidence: {
        items: [{ kind: "invoice", ref: "inv_eval_empty", confidence: 1 }],
        completeness: 0.5,
        evidence_score: 0.5,
        missing_required_evidence: ["transaction"],
        critical_missing: true,
      },
    },
    expected: expected({
      delta: 0,
      percent: 0,
      trend: "flat",
      dsoDelta: 0,
      riskCount: 0,
      renewalCount: 0,
    }),
    expect_fail_closed: true,
  },
] as const satisfies readonly GoldenScenario[];

function scenario(
  name: string,
  rationale: string,
  context: Record<string, unknown>,
  expectedFields: Readonly<Record<string, unknown>>,
): GoldenScenario {
  return {
    agent_key: "revenue_intel",
    name,
    rationale,
    input: {
      action: "create_revenue_summary",
      context,
      evidence,
    },
    expected: expectedFields,
  };
}

function baseContext(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    counterparty_id: "cp_eval_revenue",
    invoice_id: "inv_eval_revenue_1",
    transaction_id: "tx_eval_revenue_1",
    currency: "USD",
    current_period_revenue: "1000.00",
    prior_period_revenue: "1000.00",
    current_dso: 20,
    prior_dso: 20,
    ...overrides,
  };
}

function expected(input: {
  readonly delta: number;
  readonly percent: number;
  readonly trend: string;
  readonly dsoDelta: number;
  readonly riskCount: number;
  readonly renewalCount: number;
}): Readonly<Record<string, unknown>> {
  return {
    revenue_delta: input.delta,
    revenue_delta_percent: input.percent,
    revenue_trend: input.trend,
    dso_delta: input.dsoDelta,
    at_risk_customer_count: input.riskCount,
    upcoming_renewal_count: input.renewalCount,
  };
}
