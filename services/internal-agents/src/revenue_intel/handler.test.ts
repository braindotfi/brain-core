import { describe, expect, it } from "vitest";
import type { EvidenceBundle } from "../evidence.js";
import type { ProposedAction } from "../handler.js";
import { revenueIntelDefinition } from "./definition.js";
import { revenueIntelHandler } from "./handler.js";

const evidence: EvidenceBundle = {
  items: [
    { kind: "invoice", ref: "inv_1", confidence: 1 },
    { kind: "transaction", ref: "tx_1", confidence: 1 },
  ],
  completeness: 1,
  evidence_score: 1,
  missing_required_evidence: [],
  critical_missing: false,
};

describe("revenueIntelHandler", () => {
  it("computes revenue growth and notify-only mode", () => {
    const action = agentAction(
      revenueIntelHandler.build({
        action: "create_revenue_summary",
        context: baseContext({
          current_period_revenue: "1200.00",
          prior_period_revenue: "1000.00",
        }),
        evidence,
        definition: revenueIntelDefinition,
      }),
    );
    expect(action).toMatchObject({
      revenue_trend: "up",
      revenue_delta: "200.00",
      revenue_delta_percent: 20,
      mode: "notify_only",
    });
  });

  it("flags worsened DSO customers", () => {
    const action = agentAction(
      revenueIntelHandler.build({
        action: "flag_churn_risk",
        context: baseContext({ counterparty_id: "cp_slow", current_dso: 45, prior_dso: 20 }),
        evidence,
        definition: revenueIntelDefinition,
      }),
    );
    expect(action).toMatchObject({
      revenue_trend: "flat",
      at_risk_customer_count: 1,
      risk_band: "elevated",
    });
  });

  it("fails closed when required evidence is missing", () => {
    expect(() =>
      revenueIntelHandler.build({
        action: "create_revenue_summary",
        context: baseContext({}),
        evidence: {
          ...evidence,
          items: [{ kind: "invoice", ref: "inv_1" }],
          missing_required_evidence: ["transaction"],
          critical_missing: true,
        },
        definition: revenueIntelDefinition,
      }),
    ).toThrow("revenue_intel_required_evidence_missing");
  });
});

function baseContext(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    invoice_id: "inv_1",
    transaction_id: "tx_1",
    currency: "USD",
    current_period_revenue: "1000.00",
    prior_period_revenue: "1000.00",
    current_dso: 20,
    prior_dso: 20,
    ...overrides,
  };
}

function agentAction(proposed: ProposedAction): Record<string, unknown> {
  expect(proposed.channel).toBe("agent");
  if (proposed.channel !== "agent") throw new Error("expected agent proposal");
  return proposed.action;
}
