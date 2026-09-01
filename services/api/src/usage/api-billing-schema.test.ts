import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0025_api_billing_foundation.sql"),
  "utf8",
);

describe("RFC 0008 billing foundation schema", () => {
  it("keeps request facts policy-versioned and unit-bearing", () => {
    expect(migration).toContain("metering_policy_version TEXT");
    expect(migration).toContain("billable_units BIGINT NOT NULL DEFAULT 0");
    expect(migration).toContain("'requests_v1_shadow'");
  });

  it.each([
    "api_usage_daily_rollups",
    "api_usage_reconciliation_runs",
    "api_billing_periods",
    "api_billing_adjustments",
    "api_entitlement_change_log",
  ])("forces tenant RLS on %s", (table) => {
    expect(migration).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    expect(migration).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  });

  it("makes shadow period close incapable of producing charged units", () => {
    expect(migration).toContain("CHECK (mode <> 'shadow_closed' OR chargeable_units = 0)");
  });

  it("keeps member request paths unable to mutate billing and entitlement evidence", () => {
    expect(migration).toContain("FROM brain_app;");
    expect(migration).toContain(
      "GRANT INSERT ON api_usage_reconciliation_runs, api_billing_periods,",
    );
    expect(migration).not.toContain("GRANT INSERT ON api_entitlement_change_log TO brain_app");
  });
});
