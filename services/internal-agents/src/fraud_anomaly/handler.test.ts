import { describe, expect, it } from "vitest";
import { fraudAnomalyDefinition } from "./definition.js";
import { fraudAnomalyHandler } from "./handler.js";
import type { EvidenceBundle } from "../evidence.js";
import type { HandlerInput, ProposedAction } from "../handler.js";

const evidence: EvidenceBundle = {
  items: [{ kind: "transaction", ref: "tx_1", confidence: 0.95 }],
  completeness: 1,
  evidence_score: 0.95,
  missing_required_evidence: [],
  critical_missing: false,
};

describe("fraudAnomalyHandler", () => {
  it("flags a clear 10x amount anomaly", () => {
    const proposed = fraudAnomalyHandler.build(
      input({
        transaction_id: "tx_large",
        amount: "1000.00",
        account_mean_amount: "100.00",
        counterparty_mean_amount: "100.00",
        history_count: 12,
      }),
    );

    expect(proposed.channel).toBe("agent");
    expect(agentAction(proposed)).toMatchObject({
      type: "flag_transaction",
      transaction_id: "tx_large",
      anomaly_type: "unusual_amount",
      anomaly_score: 0.9,
      risk_band: "high",
      recommended_action: "hold",
      mode: "notify_only",
      evidence_refs: [{ kind: "transaction", ref: "tx_1" }],
    });
  });

  it("flags an exact duplicate charge", () => {
    const proposed = fraudAnomalyHandler.build(
      input({
        transaction_id: "tx_dup",
        amount: "49.99",
        account_mean_amount: "50.00",
        counterparty_mean_amount: "50.00",
        history_count: 20,
        duplicate_count_7d: 1,
      }),
    );

    expect(proposed.channel).toBe("agent");
    expect(agentAction(proposed)).toMatchObject({
      anomaly_type: "duplicate_charge",
      anomaly_score: 0.95,
      risk_band: "high",
      recommended_action: "hold",
      triggering_signals: ["duplicate_charge"],
    });
  });

  it("does not false-flag an in-band recurring transaction", () => {
    const proposed = fraudAnomalyHandler.build(
      input({
        transaction_id: "tx_normal",
        amount: "51.25",
        account_mean_amount: "50.00",
        counterparty_mean_amount: "50.00",
        account_stddev_amount: "5.00",
        counterparty_stddev_amount: "5.00",
        history_count: 20,
      }),
    );

    expect(proposed.channel).toBe("agent");
    expect(agentAction(proposed)).toMatchObject({
      type: "notify",
      anomaly_type: "none",
      anomaly_score: 0,
      risk_band: "standard",
      recommended_action: "monitor",
      mode: "notify_only",
    });
  });

  it("keeps near-threshold z-score below the flag threshold", () => {
    const proposed = fraudAnomalyHandler.build(
      input({
        transaction_id: "tx_near",
        amount: "124.00",
        account_mean_amount: "100.00",
        counterparty_mean_amount: "100.00",
        account_stddev_amount: "10.00",
        counterparty_stddev_amount: "10.00",
        history_count: 12,
      }),
    );

    expect(proposed.channel).toBe("agent");
    expect(agentAction(proposed)).toMatchObject({
      anomaly_type: "none",
      anomaly_score: 0,
      risk_band: "standard",
      recommended_action: "monitor",
    });
  });

  it("fails closed to monitor on insufficient history", () => {
    const proposed = fraudAnomalyHandler.build(
      input({
        transaction_id: "tx_new",
        amount: "800.00",
        history_count: 0,
      }),
    );

    expect(proposed.channel).toBe("agent");
    expect(agentAction(proposed)).toMatchObject({
      type: "notify",
      anomaly_type: "insufficient_history",
      anomaly_score: 0.1,
      risk_band: "standard",
      recommended_action: "monitor",
    });
  });

  it("rejects a missing transaction id", () => {
    expect(() => fraudAnomalyHandler.build(input({ transaction_id: "", amount: "10.00" }))).toThrow(
      "transaction_id is required",
    );
  });
});

function input(context: Record<string, unknown>): HandlerInput {
  return {
    action: "flag_transaction",
    context: {
      transaction_id: "tx_1",
      amount: "100.00",
      currency: "USD",
      transaction_date: "2026-07-18T00:00:00.000Z",
      account_id: "acct_1",
      counterparty_id: "cp_1",
      counterparty_name: "Eval Merchant",
      history_count: 10,
      ...context,
    },
    evidence,
    definition: fraudAnomalyDefinition,
    confidence: 0.95,
    now: new Date("2026-07-18T00:00:00.000Z"),
  };
}

function agentAction(proposed: ProposedAction): Record<string, unknown> {
  if (proposed.channel !== "agent") {
    throw new Error("expected agent proposal");
  }
  return proposed.action;
}
