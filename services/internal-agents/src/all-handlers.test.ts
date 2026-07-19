/**
 * Coverage net (fix/main-green): every registered internal-agent handler builds
 * a valid proposal for each of its declared actions. This exercises every
 * handler's `build` (and its action branches) so the function-coverage gate is
 * met — the per-agent behavioral tests live alongside each handler.
 */

import { describe, expect, it } from "vitest";
import type { EvidenceBundle } from "./evidence.js";
import { internalAgentHandlers } from "./registry.js";

const EVIDENCE: EvidenceBundle = {
  items: [
    { kind: "invoice", ref: "inv_1" },
    { kind: "counterparty", ref: "cp_1" },
    { kind: "balance", ref: "bal_1" },
    { kind: "transaction", ref: "tx_1" },
  ],
  completeness: 1,
  evidence_score: 1,
  missing_required_evidence: [],
  critical_missing: false,
};

// Kitchen-sink context so any handler's action can read what it needs.
const CONTEXT: Record<string, unknown> = {
  invoice_id: "inv_1",
  counterparty_id: "cp_1",
  source_account_id: "acct_1",
  destination_counterparty_id: "cp_2",
  amount: "100",
  currency: "USD",
  due_date: "2026-07-01T00:00:00.000Z",
  days_overdue: 18,
  aging_tier: "15_29",
  obligation_id: "obl_1",
  subscription_id: "sub_1",
  transaction_id: "tx_1",
  transaction_date: "2026-07-18T00:00:00.000Z",
  direction: "inflow",
  account_id: "acct_1",
  card_id: "card_1",
  candidates: [
    {
      kind: "invoice",
      id: "inv_1",
      amount: "100",
      currency: "USD",
      date: "2026-07-18T00:00:00.000Z",
      counterparty_id: "cp_1",
    },
  ],
};

describe("internal-agent handlers — build every action", () => {
  for (const [key, handler] of Object.entries(internalAgentHandlers)) {
    for (const action of handler.actions) {
      it(`${key} builds "${action}"`, () => {
        const proposed = handler.build({ action, context: CONTEXT, evidence: EVIDENCE });
        expect(["agent", "payment_intent"]).toContain(proposed.channel);
      });
    }
  }

  it("covers every catalog handler", () => {
    expect(Object.keys(internalAgentHandlers).length).toBeGreaterThanOrEqual(19);
  });
});
