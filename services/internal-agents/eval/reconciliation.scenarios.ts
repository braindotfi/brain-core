import type { EvidenceBundle } from "../src/evidence.js";
import type { GoldenScenario } from "./types.js";

const evidence: EvidenceBundle = {
  items: [{ kind: "transaction", ref: "tx_eval_1", confidence: 0.9 }],
  completeness: 1,
  evidence_score: 0.9,
  missing_required_evidence: [],
  critical_missing: false,
};

export const reconciliationScenarios = [
  scenario(
    "exact single match",
    "Reviewed reconciliation fixture: exact amount, same counterparty, and same date make inv_eval_1 the only correct match.",
    baseContext({
      candidates: [
        candidate({
          id: "inv_eval_1",
          amount: "900.00",
          date: "2026-07-18T00:00:00.000Z",
          counterparty_id: "cp_eval_1",
        }),
      ],
    }),
    [{ left_entity_id: "tx_eval_1", right_entity_id: "inv_eval_1" }],
  ),
  scenario(
    "two near amount candidates",
    "Reviewed reconciliation fixture: near-amount inv_noise is plausible but amount equality makes inv_eval_2 the known-correct pair.",
    baseContext({
      transaction_id: "tx_eval_2",
      candidates: [
        candidate({
          id: "inv_noise",
          amount: "899.99",
          date: "2026-07-18T00:00:00.000Z",
          counterparty_id: "cp_eval_1",
        }),
        candidate({
          id: "inv_eval_2",
          amount: "900.00",
          date: "2026-07-20T00:00:00.000Z",
          counterparty_id: "cp_eval_1",
        }),
      ],
    }),
    [{ left_entity_id: "tx_eval_2", right_entity_id: "inv_eval_2" }],
  ),
  scenario(
    "no candidate",
    "Reviewed reconciliation fixture: no candidate targets means the correct output is no_match and an empty match set.",
    baseContext({ transaction_id: "tx_eval_3", candidates: [] }),
    [],
  ),
  scenario(
    "same amount different counterparty false-match trap",
    "Reviewed reconciliation fixture: same amount and date but a different counterparty must not clear the confidence floor.",
    baseContext({
      transaction_id: "tx_eval_4",
      candidates: [
        candidate({
          id: "inv_wrong_cp",
          amount: "900.00",
          date: "2026-07-18T00:00:00.000Z",
          counterparty_id: "cp_other",
        }),
      ],
    }),
    [],
  ),
  {
    agent_key: "reconciliation",
    name: "missing transaction amount fails closed",
    rationale:
      "Reviewed fail-closed fixture: amount is required to score reconciliation candidates, so the handler must hold instead of emitting a proposal.",
    input: {
      action: "propose_match",
      context: omit(baseContext({}), "amount"),
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
  expectedMatches: readonly { readonly left_entity_id: string; readonly right_entity_id: string }[],
): GoldenScenario {
  return {
    agent_key: "reconciliation",
    name,
    rationale,
    input: {
      action: "propose_match",
      context,
      evidence,
    },
    expected: {
      expected_matches: expectedMatches,
    },
  };
}

function baseContext(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    transaction_id: "tx_eval_1",
    amount: "900.00",
    currency: "USD",
    direction: "inflow",
    transaction_date: "2026-07-18T00:00:00.000Z",
    counterparty_id: "cp_eval_1",
    counterparty_name: "Eval Customer",
    candidates: [],
    ...overrides,
  };
}

function candidate(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    kind: "invoice",
    id: "inv_eval",
    amount: "900.00",
    currency: "USD",
    date: "2026-07-18T00:00:00.000Z",
    counterparty_id: "cp_eval_1",
    counterparty_name: "Eval Customer",
    label: "INV-EVAL",
    status: "sent",
    ...overrides,
  };
}

function omit(input: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter((entry) => entry[0] !== key));
}
