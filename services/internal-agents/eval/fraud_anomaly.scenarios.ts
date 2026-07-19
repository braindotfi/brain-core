import type { EvidenceBundle } from "../src/evidence.js";
import type { GoldenScenario } from "./types.js";

const evidence: EvidenceBundle = {
  items: [{ kind: "transaction", ref: "tx_eval_fraud_1", confidence: 0.95 }],
  completeness: 1,
  evidence_score: 0.95,
  missing_required_evidence: [],
  critical_missing: false,
};

export const fraudAnomalyScenarios = [
  scenario(
    "clear 10x amount anomaly",
    "Reviewed fraud fixture: a 1000 transaction against a 100 recurring baseline is a clear unusual amount anomaly.",
    baseContext({
      transaction_id: "tx_eval_large",
      amount: "1000.00",
      account_mean_amount: "100.00",
      counterparty_mean_amount: "100.00",
      history_count: 12,
    }),
    { expected_anomaly: true, anomaly_type: "unusual_amount" },
  ),
  scenario(
    "exact duplicate charge",
    "Reviewed fraud fixture: a same-amount duplicate with the same counterparty inside the window is a labeled duplicate anomaly.",
    baseContext({
      transaction_id: "tx_eval_duplicate",
      amount: "49.99",
      account_mean_amount: "50.00",
      counterparty_mean_amount: "50.00",
      history_count: 20,
      duplicate_count_7d: 1,
    }),
    { expected_anomaly: true, anomaly_type: "duplicate_charge" },
  ),
  scenario(
    "clear normal recurring transaction",
    "Reviewed false-positive fixture: an in-band recurring transaction must not be flagged.",
    baseContext({
      transaction_id: "tx_eval_normal",
      amount: "51.25",
      account_mean_amount: "50.00",
      counterparty_mean_amount: "50.00",
      account_stddev_amount: "5.00",
      counterparty_stddev_amount: "5.00",
      history_count: 20,
    }),
    { expected_anomaly: false, anomaly_type: "none" },
  ),
  scenario(
    "near threshold z-score stays normal",
    "Reviewed false-positive fixture: a 2.4 standard-deviation transaction is near the threshold but should not be labeled anomalous.",
    baseContext({
      transaction_id: "tx_eval_near",
      amount: "124.00",
      account_mean_amount: "100.00",
      counterparty_mean_amount: "100.00",
      account_stddev_amount: "10.00",
      counterparty_stddev_amount: "10.00",
      history_count: 12,
    }),
    { expected_anomaly: false, anomaly_type: "none" },
  ),
  scenario(
    "insufficient history does not false flag",
    "Reviewed fail-closed fixture: without enough history the agent must monitor rather than invent a fraud label.",
    baseContext({
      transaction_id: "tx_eval_new",
      amount: "800.00",
      history_count: 0,
      account_mean_amount: null,
      counterparty_mean_amount: null,
    }),
    { expected_anomaly: false, anomaly_type: "insufficient_history" },
  ),
] as const satisfies readonly GoldenScenario[];

function scenario(
  name: string,
  rationale: string,
  context: Record<string, unknown>,
  expected: { readonly expected_anomaly: boolean; readonly anomaly_type: string },
): GoldenScenario {
  return {
    agent_key: "fraud_anomaly",
    name,
    rationale,
    input: {
      action: "flag_transaction",
      context,
      evidence,
    },
    expected,
  };
}

function baseContext(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    transaction_id: "tx_eval_fraud_1",
    amount: "100.00",
    currency: "USD",
    direction: "outflow",
    transaction_date: "2026-07-18T00:00:00.000Z",
    account_id: "acct_eval_1",
    counterparty_id: "cp_eval_merchant",
    counterparty_name: "Eval Merchant",
    history_count: 10,
    account_mean_amount: "100.00",
    counterparty_mean_amount: "100.00",
    account_stddev_amount: "10.00",
    counterparty_stddev_amount: "10.00",
    velocity_count_24h: 1,
    account_daily_count_avg: 1,
    ...overrides,
  };
}
