import { describe, expect, it } from "vitest";
import { runActivationLintGate } from "@brain/policy";
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
});
