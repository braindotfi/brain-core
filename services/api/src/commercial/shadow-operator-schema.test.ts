import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0043_commercial_shadow_operator.sql"),
  "utf8",
);
const workflow = readFileSync(
  resolve(process.cwd(), "../../.github/workflows/ops-commercial-shadow.yml"),
  "utf8",
);
const dbRoles = readFileSync(resolve(process.cwd(), "../../infra/db-roles.sql"), "utf8");

describe("commercial shadow guarded operator structure", () => {
  it("adds the exact internal provenance without weakening demo classification", () => {
    expect(migration).toContain("'internal_commercial_shadow_v1'");
    expect(migration).toContain("'synthetic_brightline_v1', 'customer'");
    expect(migration).toContain("p_tenant_id IN (");
    for (const tenantId of [
      "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ",
      "tnt_00000000010000000000000000",
      "tnt_01KYAT7A1QRKHTYW9H4RAR2SEX",
      "tnt_01M1GTBQN8R8PB6X6PN73YB6NP",
    ]) {
      expect(migration).toContain(tenantId);
    }
  });

  it("pins Growth, both credentials, and the immutable billing exclusion before start", () => {
    const start = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION start_internal_commercial_shadow"),
      migration.indexOf("CREATE OR REPLACE FUNCTION transition_internal_commercial_shadow"),
    );
    expect(start).toContain("included_api_units = 25000");
    expect(start).toContain("included_mcp_units = 2500");
    expect(start).toContain("INSERT INTO commercial_billing_exclusions");
    expect(start).toContain("INSERT INTO tenant_commercial_entitlements");
    expect(start).toContain("INSERT INTO agent_api_keys");
    expect(start).toContain("'bff_service_v1', 'live'");
    expect(start).toContain("INSERT INTO api_keys");
    expect(start).toContain("ARRAY['ledger:read','audit:read','governance:read']");
    expect(start).toContain("p_agent_key_id !~ '^agkey_");
    expect(start).toContain("octet_length(p_agent_scope_hash) <> 32");
    expect(start.indexOf("assert_internal_commercial_shadow_zero_billing")).toBeLessThan(
      start.indexOf("INSERT INTO commercial_shadow_periods"),
    );
    expect(start.indexOf("v_started_at := clock_timestamp()")).toBeLessThan(
      start.indexOf("INSERT INTO commercial_shadow_periods"),
    );
  });

  it("defines scheduler health as exact-SHA readiness no older than 15 minutes", () => {
    expect(migration).toContain("scheduler_revision = 'commercial_shadow_daily_v1'");
    expect(migration).toContain("deployed_sha = p_approved_sha");
    expect(migration).toContain("checked_at >= clock_timestamp() - interval '15 minutes'");
    expect(migration).toContain("next_run_at <= clock_timestamp() + interval '26 hours'");
    expect(workflow).toContain("systemctl is-enabled --quiet brain-commercial-shadow-daily.timer");
    expect(workflow).toContain("systemctl is-active --quiet brain-commercial-shadow-daily.timer");
  });

  it("has fixed action choices and exact mutation confirmations", () => {
    expect(workflow).toContain("options: [inspect, start, pause, stop, complete]");
    for (const action of ["START", "PAUSE", "STOP", "COMPLETE"]) {
      expect(workflow).toContain(`${action}_INTERNAL_COMMERCIAL_SHADOW_2026_10`);
    }
    expect(workflow).toContain("INSPECT_INTERNAL_COMMERCIAL_SHADOW_2026_10");
    const inputs = workflow.slice(workflow.indexOf("inputs:"), workflow.indexOf("permissions:"));
    expect(inputs).not.toContain("tenant_id:");
  });

  it("keeps lifecycle evidence immutable and revokes credentials at terminal states", () => {
    expect(migration).toContain("commercial shadow transitions are immutable");
    expect(migration).toContain("BEFORE TRUNCATE ON commercial_shadow_state_transitions");
    expect(migration).toContain("UPDATE agent_api_keys AS key SET revoked_at = clock_timestamp()");
    expect(migration).toContain("UPDATE api_keys AS key SET revoked_at = clock_timestamp()");
    expect(migration).toContain("30 complete daily observations are required");
    expect(migration).toContain("observation.api_reconciliation_run_id IS NOT NULL");
    expect(migration).toContain("api_run.status = 'matched'");
    expect(migration).toContain("mcp_run.missing_meter_count = 0");
  });

  it("self-heals the operator boundary on every database role application", () => {
    expect(dbRoles).toContain(
      "REVOKE ALL PRIVILEGES ON commercial_shadow_periods,\n" +
        "  commercial_shadow_scheduler_heartbeats,",
    );
    expect(dbRoles).toContain("GRANT SELECT ON commercial_shadow_periods TO brain_app");
    expect(dbRoles).toContain(
      "GRANT EXECUTE ON FUNCTION inspect_internal_commercial_shadow() TO brain_privileged",
    );
    expect(dbRoles).toContain("commercial shadow operator privileges are invalid");
  });
});
