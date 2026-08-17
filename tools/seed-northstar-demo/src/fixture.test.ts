import { describe, expect, it } from "vitest";
import { evaluate, runActivationLintGate } from "@brain/policy";
import { buildNorthstarPolicy } from "./index.js";
import {
  NORTHSTAR_EXPECTED,
  NORTHSTAR_MONTHLY_CASH_FLOW,
  validateNorthstarFixture,
} from "./fixture.js";

describe("Northstar Labs fixture", () => {
  it("reconciles Ledger, Overview, Wiki, and forecasting totals", () => {
    validateNorthstarFixture();
    expect(NORTHSTAR_MONTHLY_CASH_FLOW).toHaveLength(12);
    expect(NORTHSTAR_EXPECTED).toMatchObject({
      openPayables: "221300.00",
      openReceivables: "530500.00",
      overdueReceivables: "280000.00",
      revenue: 4360000,
      outflow: 3060000,
      netCashFlow: 1300000,
      augustNetCashFlow: 162000,
    });
  });

  it("keeps the curated policy lint-clean for activation", () => {
    const policy = buildNorthstarPolicy(["cp_cascade", "cp_atlas"]);
    expect(
      runActivationLintGate(policy, { lintEnforce: true, confidenceEnforce: true }).blocking,
    ).toEqual([]);
  });

  it("keeps the seeded auto rule reachable through its policy allowlist", () => {
    const policy = buildNorthstarPolicy(["cp_fathom"]);
    const decision = evaluate(policy, {
      kind: "outbound_payment",
      counterparty_id: "cp_fathom",
      amount: { currency: "USD", value: "9600.00" },
      agent_role: "payment",
      risk_level: "low",
      counterparty_trust_status: "unreviewed",
      timestamp: new Date("2026-08-15T12:00:00.000Z"),
    });

    expect(decision).toMatchObject({
      outcome: "allow",
      matched_rule_id: "northstar-ap-auto-approved",
    });
    expect(decision.trace[0]?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "counterparty.in",
          detail: "vendors.policy_allowlisted",
          passed: true,
        }),
      ]),
    );
  });
});
