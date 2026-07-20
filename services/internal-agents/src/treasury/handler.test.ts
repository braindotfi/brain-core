import { describe, expect, it } from "vitest";
import type { EvidenceBundle } from "../evidence.js";
import { treasuryHandler } from "./handler.js";

const EVIDENCE: EvidenceBundle = {
  items: [{ kind: "balance", ref: "bal_1" }],
  completeness: 1,
  evidence_score: 0.37,
  missing_required_evidence: [],
  critical_missing: false,
};

describe("treasuryHandler", () => {
  it("sets transfer confidence from the evidence score", () => {
    const proposed = treasuryHandler.build({
      action: "propose_transfer",
      context: {
        source_account_id: "acct_1",
        destination_counterparty_id: "cp_2",
        amount: "500",
        currency: "USD",
      },
      evidence: EVIDENCE,
    });

    expect(proposed.channel).toBe("payment_intent");
    if (proposed.channel !== "payment_intent") return;
    expect(proposed.intent.confidence).toBe(0.37);
  });

  it("rejects missing ids and malformed money fields before creating an intent shape", () => {
    expect(() =>
      treasuryHandler.build({
        action: "propose_transfer",
        context: {
          source_account_id: "acct_1",
          amount: "500",
          currency: "USD",
        },
        evidence: EVIDENCE,
      }),
    ).toThrow(/destination_counterparty_id/);

    expect(() =>
      treasuryHandler.build({
        action: "propose_transfer",
        context: {
          source_account_id: "acct_1",
          destination_counterparty_id: "cp_2",
          amount: 500,
          currency: "USD",
        },
        evidence: EVIDENCE,
      }),
    ).toThrow(/amount/);

    expect(() =>
      treasuryHandler.build({
        action: "propose_transfer",
        context: {
          source_account_id: "acct_1",
          destination_counterparty_id: "cp_2",
          amount: "500",
          currency: 840,
        },
        evidence: EVIDENCE,
      }),
    ).toThrow(/currency/);
  });

  it("recommends an advisory cash sweep from surplus balance", () => {
    const proposed = treasuryHandler.build({
      action: "recommend_cash_sweep",
      context: {
        balance_id: "bal_1",
        account_id: "acct_1",
        current_balance: "120000.00",
        currency: "USD",
        thresholds: {
          operating_minimum: "50000.00",
          surplus_floor: "100000.00",
          low_balance_floor: "25000.00",
        },
      },
      evidence: EVIDENCE,
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel !== "agent") return;
    expect(proposed.action.recommended_action).toBe("recommend_cash_sweep");
    expect(proposed.action.sweep_amount).toBe("70000.00");
    expect(proposed.action.mode).toBe("propose");
  });

  it("alerts low balance as notify_only advisory", () => {
    const proposed = treasuryHandler.build({
      action: "alert_low_balance",
      context: {
        balance_id: "bal_1",
        account_id: "acct_1",
        current_balance: "10000.00",
        currency: "USD",
        thresholds: {
          operating_minimum: "50000.00",
          low_balance_floor: "25000.00",
        },
      },
      evidence: EVIDENCE,
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel !== "agent") return;
    expect(proposed.action.recommended_action).toBe("alert_low_balance");
    expect(proposed.action.mode).toBe("notify_only");
  });

  it("fails closed when advisory balance context is missing", () => {
    expect(() =>
      treasuryHandler.build({
        action: "recommend_cash_sweep",
        context: {
          balance_id: "bal_1",
          currency: "USD",
        },
        evidence: EVIDENCE,
      }),
    ).toThrow(/current_balance/);
  });
});
