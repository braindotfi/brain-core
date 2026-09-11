import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  inspectCommercialShadow,
  startCommercialShadow,
  transitionCommercialShadow,
} from "./shadow-operator.js";

const databaseUrl = process.env.DATABASE_URL;
const operatorDatabaseUrl = process.env.DATABASE_URL_SHADOW_OPERATOR;
const suite = databaseUrl === undefined ? describe.skip : describe;
const approvedSha = "b".repeat(40);

suite("commercial shadow operator database contract", () => {
  let client: Client;
  let operatorClient: Client | undefined;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query("BEGIN");
    if (operatorDatabaseUrl !== undefined) {
      operatorClient = new Client({ connectionString: operatorDatabaseUrl });
      await operatorClient.connect();
    }
  });

  afterAll(async () => {
    if (client === undefined) return;
    await client.query("ROLLBACK");
    await operatorClient?.end();
    await client.end();
  });

  it("exposes only the narrow lifecycle functions to brain_privileged", async () => {
    if (operatorClient === undefined) return;
    const result = await operatorClient.query<{
      current_user: string;
      period_select: boolean;
      period_insert: boolean;
      period_update: boolean;
      start_execute: boolean;
      transition_execute: boolean;
      inspect_execute: boolean;
      zero_billing_execute: boolean;
    }>(
      `SELECT current_user,
              has_table_privilege(current_user, 'commercial_shadow_periods', 'SELECT') AS period_select,
              has_table_privilege(current_user, 'commercial_shadow_periods', 'INSERT') AS period_insert,
              has_table_privilege(current_user, 'commercial_shadow_periods', 'UPDATE') AS period_update,
              has_function_privilege(current_user, 'start_internal_commercial_shadow(text,text,text,jsonb,bytea,text,bytea,text,text,text,text,text,text,text,text,text,text,text,text)', 'EXECUTE') AS start_execute,
              has_function_privilege(current_user, 'transition_internal_commercial_shadow(text,text,text,text,text)', 'EXECUTE') AS transition_execute,
              has_function_privilege(current_user, 'inspect_internal_commercial_shadow()', 'EXECUTE') AS inspect_execute,
              has_function_privilege(current_user, 'assert_internal_commercial_shadow_zero_billing(text)', 'EXECUTE') AS zero_billing_execute`,
    );
    expect(result.rows[0]).toEqual({
      current_user: "brain_privileged",
      period_select: true,
      period_insert: false,
      period_update: false,
      start_execute: true,
      transition_execute: true,
      inspect_execute: true,
      zero_billing_execute: false,
    });
    await expect(inspectCommercialShadow(operatorClient as never)).resolves.toBeDefined();
  });

  it("rejects every protected tenant before any provisioning work", async () => {
    for (const tenantId of [
      "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ",
      "tnt_00000000010000000000000000",
      "tnt_01KYAT7A1QRKHTYW9H4RAR2SEX",
      "tnt_01M1GTBQN8R8PB6X6PN73YB6NP",
    ]) {
      await client.query("SAVEPOINT protected_tenant");
      await expect(
        client.query(
          `SELECT * FROM start_internal_commercial_shadow(
             $1,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,$2,$3,$4
           )`,
          [tenantId, approvedSha, "integration-test", "Protected tenant rejection test"],
        ),
      ).rejects.toMatchObject({ code: "22023" });
      await client.query("ROLLBACK TO SAVEPOINT protected_tenant");
    }
  });

  it("rejects start when Phase 4 has not written a fresh ready heartbeat", async () => {
    await client.query("SAVEPOINT missing_scheduler");
    await expect(
      startCommercialShadow(client as never, {
        approvedSha,
        actor: "integration-test",
        reason: "Missing scheduler heartbeat must fail closed",
        agentApiKeyPepper: "integration-agent-pepper",
        apiKeyPepper: "integration-api-pepper",
      }),
    ).rejects.toThrow(/scheduler is not healthy/);
    await client.query("ROLLBACK TO SAVEPOINT missing_scheduler");
  });

  it("provisions and starts only after every tenant-bound precondition exists", async () => {
    await client.query(
      `INSERT INTO commercial_shadow_scheduler_heartbeats (
         environment, scheduler_revision, deployed_sha, state, checked_at,
         next_run_at, run_reference
       ) VALUES (
         'live', 'commercial_shadow_daily_v1', $1, 'ready', clock_timestamp(),
         clock_timestamp() + interval '1 hour', 'integration-ready'
       ) ON CONFLICT (environment) DO UPDATE SET
         scheduler_revision = EXCLUDED.scheduler_revision,
         deployed_sha = EXCLUDED.deployed_sha,
         state = EXCLUDED.state,
         checked_at = EXCLUDED.checked_at,
         next_run_at = EXCLUDED.next_run_at,
         run_reference = EXCLUDED.run_reference`,
      [approvedSha],
    );

    const before = new Date();
    const started = await startCommercialShadow(client as never, {
      approvedSha,
      actor: "integration-test",
      reason: "Approved integration commercial shadow start",
      agentApiKeyPepper: "integration-agent-pepper",
      apiKeyPepper: "integration-api-pepper",
    });
    const startedAt = new Date(started.startedAt);
    expect(startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());

    const state = await inspectCommercialShadow(client as never);
    expect(state).toMatchObject({
      tenant_id: started.bundle.tenant_id,
      shadow_period_id: started.bundle.shadow_period_id,
      state: "running",
      growth_entitlement_valid: true,
      billing_exclusion_present: true,
      zero_billing_state: true,
      bff_agent_key_active: true,
      commercial_api_key_active: true,
      protected_tenant_match: false,
      provenance: {
        kind: "production",
        provisioning_state: null,
        data_profile: "internal_commercial_shadow_v1",
        access_stage: "production",
      },
      contract: {
        catalog_revision_id: "robotmoney_growth_v1",
        environment: "live",
        api_unit_allowance: 25000,
        mcp_unit_allowance: 2500,
      },
    });
    expect(started.bundle.BRAIN_AGENT_API_KEY).toMatch(/^brain_ak_live_/);
    expect(started.bundle.BRAIN_API_KEY).toMatch(/^brain_sk_live_/);
  });

  it("pauses, resumes, stops safely, and completes only with 30 complete days", async () => {
    const before = await inspectCommercialShadow(client as never);
    const originalStartedAt = before["started_at"];
    await transitionCommercialShadow(client as never, {
      action: "pause",
      approvedSha,
      actor: "integration-test",
      reason: "Pause integration shadow for controlled review",
    });
    await expect(inspectCommercialShadow(client as never)).resolves.toMatchObject({
      state: "paused",
      started_at: originalStartedAt,
    });
    await transitionCommercialShadow(client as never, {
      action: "resume",
      approvedSha,
      actor: "integration-test",
      reason: "Resume integration shadow after controlled review",
    });
    await expect(inspectCommercialShadow(client as never)).resolves.toMatchObject({
      state: "running",
      started_at: originalStartedAt,
    });

    await client.query("SAVEPOINT stop_transition");
    await transitionCommercialShadow(client as never, {
      action: "stop",
      approvedSha,
      actor: "integration-test",
      reason: "Stop integration shadow after lifecycle test",
    });
    await expect(inspectCommercialShadow(client as never)).resolves.toMatchObject({
      state: "stopped",
      bff_agent_key_active: false,
      commercial_api_key_active: false,
    });
    await client.query("ROLLBACK TO SAVEPOINT stop_transition");

    await client.query("SAVEPOINT early_complete");
    await expect(
      transitionCommercialShadow(client as never, {
        action: "complete",
        approvedSha,
        actor: "integration-test",
        reason: "Completion before thirty days must fail closed",
      }),
    ).rejects.toThrow(/at least 30 days/);
    await client.query("ROLLBACK TO SAVEPOINT early_complete");

    const running = await inspectCommercialShadow(client as never);
    await client.query(
      `UPDATE commercial_shadow_periods
          SET started_at = clock_timestamp() - interval '31 days'
        WHERE id = $1`,
      [running["shadow_period_id"]],
    );
    await client.query(
      `INSERT INTO api_usage_reconciliation_runs (
         id, idempotency_key, tenant_id, environment, period_start, period_end,
         metering_policy_version, raw_request_count, raw_billable_units,
         raw_limiter_decision_count, rollup_request_count, rollup_billable_units,
         gateway_request_count, limiter_decision_count, meter_persistence_failures,
         status, discrepancy, actor
       ) VALUES (
         'urr_phase3_complete', 'phase3-api-complete', $1, 'live',
         clock_timestamp() - interval '31 days', clock_timestamp(),
         'requests_v1_shadow', 0, 0, 0, 0, 0, 0, 0, 0, 'matched', '{}',
         'integration-test'
       )`,
      [running["tenant_id"]],
    );
    await client.query(
      `INSERT INTO mcp_usage_reconciliation_runs (
         id, idempotency_key, tenant_id, shadow_period_id, environment,
         period_start, period_end, metering_policy_version,
         transport_request_count, raw_meter_request_count, raw_billable_units,
         rollup_request_count, rollup_billable_units, missing_meter_count,
         unexpected_meter_count, meter_persistence_failures, status, discrepancy,
         actor
       ) VALUES (
         'murr_phase3_complete', 'phase3-mcp-complete', $1, $2, 'live',
         clock_timestamp() - interval '31 days', clock_timestamp(),
         'mcp_tools_v1_shadow', 0, 0, 0, 0, 0, 0, 0, 0, 'matched', '{}',
         'integration-test'
       )`,
      [running["tenant_id"], running["shadow_period_id"]],
    );
    await client.query(
      `INSERT INTO commercial_shadow_observations (
         id, tenant_id, shadow_period_id, catalog_revision_id,
         catalog_resolution, entity_count, counted_agent_count,
         execution_settled_minor_units, execution_reserved_minor_units,
         entity_capacity_result, agent_capacity_result, execution_limit_result,
         api_units, mcp_units, api_unit_result, mcp_unit_result,
         api_evidence_complete, mcp_evidence_complete,
         api_reconciliation_run_id, mcp_reconciliation_run_id, divergence_codes,
         evidence, enforcement_applied, observed_at
       )
       SELECT 'cso_phase3_' || day::text, $1, $2, 'robotmoney_growth_v1',
              'explicit', 1, 0, 0, 0, 'within', 'within', 'within',
              day, day, 'within', 'within', TRUE, TRUE,
              'urr_phase3_complete', 'murr_phase3_complete', ARRAY[]::TEXT[],
              '{}'::jsonb, FALSE, clock_timestamp() - (day * interval '1 day')
         FROM generate_series(1, 30) AS day`,
      [running["tenant_id"], running["shadow_period_id"]],
    );
    await transitionCommercialShadow(client as never, {
      action: "complete",
      approvedSha,
      actor: "integration-test",
      reason: "Complete integration shadow with thirty reconciled days",
    });
    await expect(inspectCommercialShadow(client as never)).resolves.toMatchObject({
      state: "completed",
      bff_agent_key_active: false,
      commercial_api_key_active: false,
    });
  });
});
