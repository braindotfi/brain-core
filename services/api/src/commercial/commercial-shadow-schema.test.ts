import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0042_commercial_shadow_api_mcp_contract.sql"),
  "utf8",
);
const transport = readFileSync(resolve(process.cwd(), "../mcp/src/transport/http.ts"), "utf8");

describe("commercial shadow API and MCP contract schema", () => {
  it("binds each period to exactly one tenant and pins both unit allowances", () => {
    expect(migration).toContain("CREATE TABLE commercial_shadow_contracts");
    expect(migration).toContain("shadow_period_id      TEXT        NOT NULL UNIQUE");
    expect(migration).toContain("PRIMARY KEY (tenant_id, shadow_period_id)");
    expect(migration).toContain("api_unit_allowance    BIGINT      NOT NULL");
    expect(migration).toContain("mcp_unit_allowance    BIGINT      NOT NULL");
    expect(migration).toContain("contract_version = 'commercial_shadow_v1'");
  });

  it("adds API and MCP units, completeness, reconciliation ids, and tri-state results", () => {
    for (const field of [
      "api_units BIGINT NOT NULL",
      "mcp_units BIGINT NOT NULL",
      "api_unit_result TEXT NOT NULL",
      "mcp_unit_result TEXT NOT NULL",
      "api_evidence_complete BOOLEAN NOT NULL",
      "mcp_evidence_complete BOOLEAN NOT NULL",
      "api_reconciliation_run_id TEXT",
      "mcp_reconciliation_run_id TEXT",
    ]) {
      expect(migration).toContain(field);
    }
    expect(migration).toContain("IN ('within', 'over', 'unresolved')");
  });

  it("keeps transport observations, meter facts, and derived rollups independent", () => {
    expect(migration).toContain("CREATE TABLE mcp_transport_tool_observations");
    expect(migration).toContain("CREATE TABLE mcp_tool_meter_events");
    expect(migration).toContain("CREATE TABLE mcp_usage_daily_rollups");
    const meterDefinition = migration.slice(
      migration.indexOf("CREATE TABLE mcp_tool_meter_events"),
      migration.indexOf("CREATE INDEX idx_mcp_tool_meter_events_period"),
    );
    expect(meterDefinition).not.toContain("REFERENCES mcp_transport_tool_observations");
    expect(transport.indexOf("observeTransport")).toBeLessThan(transport.indexOf("server.handle"));
    expect(migration).toContain("derived only from mcp_tool_meter_events");
  });

  it("forces tenant RLS and append-only mutation guards on immutable evidence", () => {
    for (const table of [
      "commercial_shadow_contracts",
      "mcp_transport_tool_observations",
      "mcp_tool_meter_events",
      "mcp_meter_persistence_failure_events",
      "mcp_usage_daily_rollups",
      "mcp_usage_reconciliation_runs",
    ]) {
      expect(migration).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(migration).toContain("commercial shadow evidence is immutable");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON mcp_tool_metering_policies");
    expect(migration).toContain("BEFORE TRUNCATE ON mcp_tool_metering_policies");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON commercial_shadow_observations");
    expect(migration).toContain("BEFORE TRUNCATE ON commercial_shadow_observations");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON mcp_tool_meter_events");
    expect(migration).toContain("BEFORE TRUNCATE ON mcp_tool_meter_events");
  });

  it("resets runtime ACLs and grants only the required evidence append paths", () => {
    expect(migration).toContain(
      "REVOKE ALL PRIVILEGES ON commercial_shadow_contracts, commercial_shadow_observations,",
    );
    expect(migration).toContain(
      "GRANT INSERT ON commercial_shadow_observations,\n" +
        "      mcp_transport_tool_observations, mcp_tool_meter_events,",
    );
    expect(migration).not.toContain("GRANT UPDATE ON mcp_tool_meter_events");
    expect(migration).not.toContain("GRANT DELETE ON mcp_tool_meter_events");
  });
});
