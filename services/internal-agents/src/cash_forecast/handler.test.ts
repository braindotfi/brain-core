import { describe, expect, it } from "vitest";
import type { EvidenceBundle } from "../evidence.js";
import { cashForecastHandler } from "./handler.js";

const evidence: EvidenceBundle = {
  items: [{ kind: "balance", ref: "bal_1", confidence: 0.95 }],
  completeness: 1,
  evidence_score: 0.95,
  missing_required_evidence: [],
  critical_missing: false,
};

describe("cashForecastHandler", () => {
  it("projects net cash over 30, 60, and 90 day horizons", () => {
    const proposed = cashForecastHandler.build({
      action: "generate_forecast",
      now: new Date("2026-07-18T00:00:00.000Z"),
      context: {
        balance_id: "bal_1",
        current_balance: "1000.00",
        currency: "USD",
        receivables: [
          { invoice_id: "inv_30", amount: "500.00", currency: "USD", due_date: "2026-08-17" },
          { invoice_id: "inv_60", amount: "700.00", currency: "USD", due_date: "2026-09-16" },
        ],
        payables: [
          { obligation_id: "obl_30", amount: "300.00", currency: "USD", due_date: "2026-08-01" },
          { obligation_id: "obl_90", amount: "400.00", currency: "USD", due_date: "2026-10-16" },
        ],
      },
      evidence,
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action).toMatchObject({
        type: "cash_forecast",
        projected_net_position: {
          day_30: "1200.00",
          day_60: "1900.00",
          day_90: "1500.00",
        },
        min_projected_balance: "700.00",
        min_projected_balance_date: "2026-08-01",
        shortfall_date: null,
        recommended_action: "hold",
      });
    }
  });

  it("alerts on a projected shortfall and uses the fixed clock for horizon dates", () => {
    const proposed = cashForecastHandler.build({
      action: "alert_shortfall",
      now: new Date("2026-07-18T00:00:00.000Z"),
      context: {
        balance_id: "bal_1",
        current_balance: "100.00",
        currency: "USD",
        receivables: [],
        payables: [
          { obligation_id: "obl_short", amount: "250.00", currency: "USD", due_date: "2026-07-28" },
        ],
      },
      evidence,
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action).toMatchObject({
        recommended_action: "shortfall_alert",
        shortfall_date: "2026-07-28",
        period_start: "2026-07-18",
        period_end: "2026-10-16",
      });
    }
  });

  it("fails closed when balance context is missing", () => {
    expect(() =>
      cashForecastHandler.build({
        action: "generate_forecast",
        now: new Date("2026-07-18T00:00:00.000Z"),
        context: {
          balance_id: "bal_1",
          currency: "USD",
          receivables: [],
          payables: [],
        },
        evidence,
      }),
    ).toThrow(/current_balance is required/);
  });
});
