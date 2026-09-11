import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl === undefined ? describe.skip : describe;
const schema = `commercial_shadow_contract_${process.pid}_${Date.now()}`;

suite("commercial shadow API and MCP database contract", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE tenants (id TEXT PRIMARY KEY);
      CREATE TABLE api_commercial_tier_catalog (id TEXT PRIMARY KEY);
      CREATE TABLE commercial_shadow_periods (
        id TEXT PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL,
        minimum_days INTEGER NOT NULL DEFAULT 30,
        completed_at TIMESTAMPTZ,
        reviewed_at TIMESTAMPTZ,
        reviewed_by TEXT,
        review_outcome TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE api_usage_reconciliation_runs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        UNIQUE (tenant_id, id)
      );
      CREATE TABLE commercial_shadow_observations (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        shadow_period_id TEXT NOT NULL,
        catalog_revision_id TEXT,
        catalog_resolution TEXT NOT NULL,
        entity_count INTEGER NOT NULL,
        counted_agent_count INTEGER NOT NULL,
        execution_settled_minor_units BIGINT NOT NULL,
        execution_reserved_minor_units BIGINT NOT NULL,
        execution_currency TEXT NOT NULL DEFAULT 'USD',
        entity_capacity_result TEXT NOT NULL,
        agent_capacity_result TEXT NOT NULL,
        execution_limit_result TEXT NOT NULL,
        divergence_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        evidence JSONB NOT NULL,
        enforcement_applied BOOLEAN NOT NULL DEFAULT FALSE,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, id)
      );
    `);
    const migration = await readFile(
      resolve(process.cwd(), "migrations/0042_commercial_shadow_api_mcp_contract.sql"),
      "utf8",
    );
    await client.query(migration);
    await client.query(`
      INSERT INTO tenants (id) VALUES ('tnt_a'), ('tnt_b');
      INSERT INTO api_commercial_tier_catalog (id) VALUES ('robotmoney_growth_v1');
      INSERT INTO commercial_shadow_periods (id, started_at)
      VALUES ('csp_october', '2026-10-01T00:00:00Z');
      INSERT INTO commercial_shadow_contracts (
        tenant_id, shadow_period_id, catalog_revision_id, entitlement_version,
        environment, api_unit_allowance, mcp_unit_allowance, created_by
      ) VALUES (
        'tnt_a', 'csp_october', 'robotmoney_growth_v1', 1,
        'live', 25000, 2500, 'integration-test'
      );
    `);
  });

  afterAll(async () => {
    if (client === undefined) return;
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  });

  it("prevents a shadow period from being rebound to another tenant", async () => {
    await expect(
      client.query(`
        INSERT INTO commercial_shadow_contracts (
          tenant_id, shadow_period_id, catalog_revision_id, entitlement_version,
          environment, api_unit_allowance, mcp_unit_allowance, created_by
        ) VALUES (
          'tnt_b', 'csp_october', 'robotmoney_growth_v1', 1,
          'live', 25000, 2500, 'integration-test'
        )
      `),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("keeps transport and meter facts independently appendable", async () => {
    await client.query(`
      INSERT INTO mcp_transport_tool_observations (
        tenant_id, request_id, shadow_period_id, environment, principal_type,
        principal_id, tool_name, limiter_decision, occurred_at
      ) VALUES (
        'tnt_a', 'req_transport_only', 'csp_october', 'live', 'agent',
        'agent_a', 'ledger.accounts.list', TRUE, '2026-10-01T01:00:00Z'
      );
      INSERT INTO mcp_tool_meter_events (
        id, tenant_id, request_id, shadow_period_id, environment, principal_type,
        principal_id, tool_name, status_code, outcome, rejection_reason,
        metering_policy_version, billable_units, occurred_at
      ) VALUES (
        'mmtr_meter_only', 'tnt_a', 'req_meter_only', 'csp_october', 'live',
        'agent', 'agent_a', 'ledger.accounts.list', 200, 'success', NULL,
        'mcp_tools_v1_shadow', 1, '2026-10-01T01:01:00Z'
      );
    `);
    const result = await client.query(`
      SELECT
        (SELECT count(*) FROM mcp_transport_tool_observations) AS transport_count,
        (SELECT count(*) FROM mcp_tool_meter_events) AS meter_count
    `);
    expect(result.rows[0]).toEqual({ transport_count: "1", meter_count: "1" });
  });

  it.each([
    "commercial_shadow_contracts",
    "mcp_tool_metering_policies",
    "mcp_transport_tool_observations",
    "mcp_tool_meter_events",
  ])("rejects update, delete, and truncate for immutable %s evidence", async (table) => {
    await expect(client.query(`UPDATE ${table} SET created_at = created_at`)).rejects.toMatchObject(
      {
        code: "55000",
      },
    );
    await expect(client.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: "55000" });
    await expect(client.query(`TRUNCATE ${table}`)).rejects.toBeDefined();
  });

  it("accepts an immutable observation with both reconciled unit dimensions", async () => {
    await client.query(`
      INSERT INTO api_usage_reconciliation_runs (id, tenant_id)
      VALUES ('urr_api', 'tnt_a');
      INSERT INTO mcp_usage_reconciliation_runs (
        id, idempotency_key, tenant_id, shadow_period_id, environment,
        period_start, period_end, metering_policy_version,
        transport_request_count, raw_meter_request_count, raw_billable_units,
        rollup_request_count, rollup_billable_units, missing_meter_count,
        unexpected_meter_count, meter_persistence_failures, status, discrepancy,
        actor
      ) VALUES (
        'murr_mcp', 'mcp-reconcile', 'tnt_a', 'csp_october', 'live',
        '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z',
        'mcp_tools_v1_shadow', 1, 1, 1, 1, 1, 0, 0, 0, 'matched', '{}',
        'integration-test'
      );
      INSERT INTO commercial_shadow_observations (
        id, tenant_id, shadow_period_id, catalog_revision_id, catalog_resolution,
        entity_count, counted_agent_count, execution_settled_minor_units,
        execution_reserved_minor_units, entity_capacity_result,
        agent_capacity_result, execution_limit_result, api_units, mcp_units,
        api_unit_result, mcp_unit_result, api_evidence_complete,
        mcp_evidence_complete, api_reconciliation_run_id,
        mcp_reconciliation_run_id, divergence_codes, evidence,
        enforcement_applied
      ) VALUES (
        'cso_one', 'tnt_a', 'csp_october', 'robotmoney_growth_v1', 'explicit',
        1, 1, 0, 0, 'within', 'within', 'within', 10, 1, 'within', 'within',
        TRUE, TRUE, 'urr_api', 'murr_mcp', ARRAY[]::TEXT[], '{}', FALSE
      )
    `);
    await expect(
      client.query(`UPDATE commercial_shadow_observations SET api_units = 11`),
    ).rejects.toMatchObject({ code: "55000" });
  });
});
