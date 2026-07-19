import { describe, expect, it } from "vitest";
import type { EvidenceBundle } from "../evidence.js";
import type { ProposedAction } from "../handler.js";
import { subscriptionDefinition } from "./definition.js";
import { subscriptionHandler } from "./handler.js";

const evidence: EvidenceBundle = {
  items: [{ kind: "transaction", ref: "tx_3", confidence: 1 }],
  completeness: 1,
  evidence_score: 1,
  missing_required_evidence: [],
  critical_missing: false,
};

describe("subscriptionHandler", () => {
  it("flags regular recurring charges", () => {
    const action = agentAction(
      subscriptionHandler.build({
        action: "flag_subscription",
        context: baseContext({}),
        evidence,
        definition: subscriptionDefinition,
      }),
    );
    expect(action).toMatchObject({
      is_subscription: true,
      cadence: "monthly",
      recommended_action: "flag_subscription",
      next_expected_date: "2026-08-18",
      mode: "propose",
    });
  });

  it("recommends review when a recurring charge jumps materially", () => {
    const action = agentAction(
      subscriptionHandler.build({
        action: "flag_subscription",
        context: baseContext({
          amount: "130.00",
          history: [
            charge("tx_1", "100.00", "2026-05-18"),
            charge("tx_2", "100.00", "2026-06-18"),
            charge("tx_3", "130.00", "2026-07-18"),
          ],
        }),
        evidence,
        definition: subscriptionDefinition,
      }),
    );
    expect(action).toMatchObject({
      is_subscription: true,
      recommended_action: "review_price_change",
      price_change_percent: 30,
    });
  });

  it("does not flag irregular cadence as a subscription", () => {
    const action = agentAction(
      subscriptionHandler.build({
        action: "flag_subscription",
        context: baseContext({
          history: [
            charge("tx_1", "100.00", "2026-05-01"),
            charge("tx_2", "100.00", "2026-06-18"),
            charge("tx_3", "100.00", "2026-07-18"),
          ],
        }),
        evidence,
        definition: subscriptionDefinition,
      }),
    );
    expect(action).toMatchObject({ is_subscription: false, recommended_action: "monitor" });
  });

  it("fails closed with insufficient history", () => {
    expect(() =>
      subscriptionHandler.build({
        action: "flag_subscription",
        context: baseContext({ history: [charge("tx_1", "100.00", "2026-06-18")] }),
        evidence,
        definition: subscriptionDefinition,
      }),
    ).toThrow("subscription_required_history_missing");
  });
});

function baseContext(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    transaction_id: "tx_3",
    counterparty_id: "cp_1",
    amount: "100.00",
    currency: "USD",
    transaction_date: "2026-07-18",
    history: [
      charge("tx_1", "100.00", "2026-05-18"),
      charge("tx_2", "100.00", "2026-06-18"),
      charge("tx_3", "100.00", "2026-07-18"),
    ],
    ...overrides,
  };
}

function charge(
  transactionId: string,
  amount: string,
  transactionDate: string,
): Record<string, unknown> {
  return { transaction_id: transactionId, amount, transaction_date: transactionDate };
}

function agentAction(proposed: ProposedAction): Record<string, unknown> {
  expect(proposed.channel).toBe("agent");
  if (proposed.channel !== "agent") throw new Error("expected agent proposal");
  return proposed.action;
}
