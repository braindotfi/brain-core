import { describe, expect, it } from "vitest";
import { evaluate, runActivationLintGate } from "@brain/policy";
import { buildNorthstarPolicy } from "./index.js";
import { buildNorthstarFixture, NORTHSTAR_EXPECTED, validateNorthstarFixture } from "./fixture.js";
import {
  buildNorthstarHistoricalSources,
  buildNorthstarHistoricalSourceMetadata,
  NORTHSTAR_ACCOUNT_EXTERNAL_IDS,
} from "./historical-sources.js";

describe("Northstar Labs fixture", () => {
  it("defines honest provenance sources without live connection claims", () => {
    const sources = buildNorthstarHistoricalSources({
      operating: "acct_operating",
      reserve: "acct_reserve",
      card: "acct_card",
    });

    expect(sources).toHaveLength(5);
    expect(sources.map((source) => source.providerName)).toEqual([
      "Harborline Bank",
      "Keystone Corporate Card",
      "Meridian Benefits",
      "Internal Revenue Service",
      "Northstar Labs",
    ]);
    expect(sources.map((source) => source.sourceCategory)).toEqual(
      expect.arrayContaining(["banking_cash", "payroll_hr", "tax_records", "accounting_erp"]),
    );
    expect(sources[0]?.externalAccountIds).toEqual([
      NORTHSTAR_ACCOUNT_EXTERNAL_IDS.operating,
      NORTHSTAR_ACCOUNT_EXTERNAL_IDS.reserve,
    ]);
    expect(sources[1]?.externalAccountIds).toEqual([NORTHSTAR_ACCOUNT_EXTERNAL_IDS.card]);
    expect(sources.slice(2).every((source) => source.externalAccountIds.length === 0)).toBe(true);

    for (const source of sources) {
      expect(
        buildNorthstarHistoricalSourceMetadata(source, "2026-08-22T00:00:00.000Z"),
      ).toMatchObject({
        seed_key: "northstar_labs_v1",
        origin_mode: "historical_import",
        live_connection: false,
        sync_disabled: true,
        disconnectable: false,
        disconnect_hidden: true,
      });
    }
  });

  it("reconciles Ledger, Overview, Wiki, and forecasting totals", () => {
    const fixture = buildNorthstarFixture(new Date("2026-08-15T23:45:00.000Z"));
    validateNorthstarFixture(fixture);
    expect(fixture.asOfIso).toBe("2026-08-15T00:00:00.000Z");
    expect(fixture.monthlyCashFlow).toHaveLength(12);
    expect(fixture.monthlyCashFlow[0]?.transactionDate).toBe("2025-09-15T00:00:00.000Z");
    expect(fixture.monthlyCashFlow[11]?.transactionDate).toBe("2026-08-15T00:00:00.000Z");
    expect(fixture.payables[0]?.[3]).toBe("2026-08-19");
    expect(fixture.receivables[0]?.slice(3, 5)).toEqual(["2026-06-01", "2026-07-04"]);
    expect(NORTHSTAR_EXPECTED).toMatchObject({
      openPayables: "221300.00",
      openReceivables: "530500.00",
      overdueReceivables: "280000.00",
      revenue: 4360000,
      outflow: 3060000,
      netCashFlow: 1300000,
      latestMonthNetCashFlow: 162000,
    });
  });

  it("keeps every generated date relative to the requested snapshot", () => {
    const fixture = buildNorthstarFixture(new Date("2027-03-01T01:00:00.000Z"));

    expect(fixture.asOfIso).toBe("2027-03-01T00:00:00.000Z");
    expect(fixture.monthlyCashFlow.map((month) => month.month)).toEqual([
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
      "2027-03",
    ]);
    expect(fixture.monthlyCashFlow.at(-1)?.transactionDate).toBe("2027-03-01T00:00:00.000Z");
    expect(fixture.payables.map((row) => row[3])).toEqual([
      "2027-03-05",
      "2027-03-08",
      "2027-03-16",
      "2027-03-18",
      "2027-03-04",
      "2027-04-01",
      "2027-03-06",
    ]);
    expect(fixture.receivables[0]?.slice(3, 5)).toEqual(["2026-12-16", "2027-01-18"]);
  });

  it("keeps the curated policy lint-clean for activation", () => {
    const policy = buildNorthstarPolicy(["cp_cascade", "cp_atlas"]);
    expect(
      runActivationLintGate(policy, { lintEnforce: true, confidenceEnforce: true }).blocking,
    ).toEqual([]);
  });

  it("accepts the Payment agent's trusted risk signal through the auto rule", () => {
    const policy = buildNorthstarPolicy(["cp_fathom"]);
    const decision = evaluate(policy, {
      kind: "outbound_payment",
      counterparty_id: "cp_fathom",
      amount: { currency: "USD", value: "5000.00" },
      agent_role: "payment",
      risk_level: "medium",
      counterparty_trust_status: "unreviewed",
      timestamp: new Date("2026-08-15T12:00:00.000Z"),
    });

    expect(decision).toMatchObject({
      outcome: "allow",
      matched_rule_id: "northstar-ap-auto-approved",
    });
    expect(policy.rules[0]?.ach_autonomous_max_amount).toEqual({
      currency: "USD",
      value: "10000.00",
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

  it("keeps a direct payment request without an agent risk signal in review", () => {
    const policy = buildNorthstarPolicy(["cp_fathom"]);
    const decision = evaluate(policy, {
      kind: "outbound_payment",
      counterparty_id: "cp_fathom",
      amount: { currency: "USD", value: "5000.00" },
      agent_role: null,
      risk_level: null,
      counterparty_trust_status: "unreviewed",
      timestamp: new Date("2026-08-15T12:00:00.000Z"),
    });

    expect(decision).toMatchObject({
      outcome: "confirm",
      matched_rule_id: "northstar-ap-review",
    });
    expect(decision.trace[0]?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "agent.risk_level.lte", passed: false }),
      ]),
    );
  });
});
