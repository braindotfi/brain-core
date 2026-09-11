import type { Pool } from "pg";
import {
  newMcpUsageReconciliationRunId,
  withTenantScope,
  type TenantScopedClient,
} from "@brain/shared";
import { MCP_SHADOW_METERING_POLICY } from "@brain/mcp";

export interface ReconcileMcpShadowUsageInput {
  readonly tenantId: string;
  readonly shadowPeriodId: string;
  readonly environment: "sandbox" | "live";
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly idempotencyKey: string;
  readonly actor: string;
}

export interface McpShadowUsageReconciliationResult {
  readonly id: string;
  readonly status: "matched" | "mismatch" | "incomplete";
  readonly transportRequestCount: number;
  readonly rawMeterRequestCount: number;
  readonly rawBillableUnits: number;
  readonly rollupRequestCount: number;
  readonly rollupBillableUnits: number;
  readonly missingMeterCount: number;
  readonly unexpectedMeterCount: number;
  readonly meterPersistenceFailures: number;
  readonly discrepancy: Record<string, { expected: number; actual: number }>;
}

interface CountRow {
  request_count: string | number;
  billable_units: string | number;
  high_water_at?: Date | string | null;
  high_water_id?: string | null;
}

interface CompletenessRow {
  transport_request_count: string | number;
  missing_meter_count: string | number;
  unexpected_meter_count: string | number;
  meter_persistence_failures: string | number;
  high_water_at: Date | string | null;
  high_water_id: string | null;
}

export async function reconcileMcpShadowUsage(
  pool: Pool,
  input: ReconcileMcpShadowUsageInput,
): Promise<McpShadowUsageReconciliationResult> {
  assertPeriod(input.periodStart, input.periodEnd);
  return withTenantScope(pool, input.tenantId, async (client) => {
    const existing = await client.query<StoredReconciliationRow>(
      `SELECT id, status, transport_request_count, raw_meter_request_count,
              raw_billable_units, rollup_request_count, rollup_billable_units,
              missing_meter_count, unexpected_meter_count,
              meter_persistence_failures, discrepancy
         FROM mcp_usage_reconciliation_runs
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [input.tenantId, input.idempotencyKey],
    );
    if (existing.rows[0] !== undefined) return serialize(existing.rows[0]);

    const contract = await client.query(
      `SELECT 1
         FROM commercial_shadow_contracts AS contract
         JOIN commercial_shadow_periods AS period
           ON period.id = contract.shadow_period_id
        WHERE contract.tenant_id = $1
          AND contract.shadow_period_id = $2
          AND contract.environment = $3
          AND period.started_at = $4
          AND $5::timestamptz > period.started_at
          AND period.state = 'running'
          AND period.completed_at IS NULL`,
      [input.tenantId, input.shadowPeriodId, input.environment, input.periodStart, input.periodEnd],
    );
    if (contract.rows[0] === undefined) {
      throw new Error("active tenant-bound commercial shadow contract does not match period");
    }

    await rebuildDailyRollups(client, input);
    const raw = await meterTotals(client, input);
    const rollup = await rollupTotals(client, input);
    const completeness = await completenessTotals(client, input);
    const rawMeterRequestCount = toCount(raw.request_count, "raw meter request count");
    const rawBillableUnits = toCount(raw.billable_units, "raw MCP units");
    const rollupRequestCount = toCount(rollup.request_count, "rollup request count");
    const rollupBillableUnits = toCount(rollup.billable_units, "rollup MCP units");
    const transportRequestCount = toCount(
      completeness.transport_request_count,
      "transport request count",
    );
    const missingMeterCount = toCount(completeness.missing_meter_count, "missing meter count");
    const unexpectedMeterCount = toCount(
      completeness.unexpected_meter_count,
      "unexpected meter count",
    );
    const meterPersistenceFailures = toCount(
      completeness.meter_persistence_failures,
      "meter persistence failures",
    );
    const discrepancy: Record<string, { expected: number; actual: number }> = {};
    compare(discrepancy, "transport_requests", transportRequestCount, rawMeterRequestCount);
    compare(discrepancy, "rollup_requests", rawMeterRequestCount, rollupRequestCount);
    compare(discrepancy, "rollup_units", rawBillableUnits, rollupBillableUnits);
    if (missingMeterCount > 0) {
      discrepancy.missing_meter_rows = { expected: 0, actual: missingMeterCount };
    }
    if (unexpectedMeterCount > 0) {
      discrepancy.unexpected_meter_rows = { expected: 0, actual: unexpectedMeterCount };
    }
    if (meterPersistenceFailures > 0) {
      discrepancy.meter_persistence_failures = {
        expected: 0,
        actual: meterPersistenceFailures,
      };
    }
    const status =
      missingMeterCount > 0 || meterPersistenceFailures > 0
        ? "incomplete"
        : Object.keys(discrepancy).length === 0
          ? "matched"
          : "mismatch";
    const id = newMcpUsageReconciliationRunId();
    await client.query(
      `INSERT INTO mcp_usage_reconciliation_runs (
         id, idempotency_key, tenant_id, shadow_period_id, environment,
         period_start, period_end, metering_policy_version,
         transport_request_count, raw_meter_request_count, raw_billable_units,
         rollup_request_count, rollup_billable_units, missing_meter_count,
         unexpected_meter_count, meter_persistence_failures, status, discrepancy,
         transport_high_water_at, transport_high_water_id, meter_high_water_at,
         meter_high_water_id, actor
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18::jsonb, $19, $20, $21, $22, $23
       )`,
      [
        id,
        input.idempotencyKey,
        input.tenantId,
        input.shadowPeriodId,
        input.environment,
        input.periodStart,
        input.periodEnd,
        MCP_SHADOW_METERING_POLICY,
        transportRequestCount,
        rawMeterRequestCount,
        rawBillableUnits,
        rollupRequestCount,
        rollupBillableUnits,
        missingMeterCount,
        unexpectedMeterCount,
        meterPersistenceFailures,
        status,
        JSON.stringify(discrepancy),
        completeness.high_water_at,
        completeness.high_water_id,
        raw.high_water_at ?? null,
        raw.high_water_id ?? null,
        input.actor,
      ],
    );
    return {
      id,
      status,
      transportRequestCount,
      rawMeterRequestCount,
      rawBillableUnits,
      rollupRequestCount,
      rollupBillableUnits,
      missingMeterCount,
      unexpectedMeterCount,
      meterPersistenceFailures,
      discrepancy,
    };
  });
}

async function rebuildDailyRollups(
  client: TenantScopedClient,
  input: ReconcileMcpShadowUsageInput,
): Promise<void> {
  await client.query(
    `DELETE FROM mcp_usage_daily_rollups
      WHERE tenant_id = $1 AND shadow_period_id = $2 AND environment = $3
        AND rollup_date >= ($4::timestamptz AT TIME ZONE 'UTC')::date
        AND rollup_date < ($5::timestamptz AT TIME ZONE 'UTC')::date`,
    [input.tenantId, input.shadowPeriodId, input.environment, input.periodStart, input.periodEnd],
  );
  await client.query(
    `INSERT INTO mcp_usage_daily_rollups (
       tenant_id, shadow_period_id, rollup_date, environment, tool_name,
       outcome, metering_policy_version, request_count, billable_units,
       source_last_occurred_at, source_last_event_id
     )
     SELECT tenant_id, shadow_period_id,
            (occurred_at AT TIME ZONE 'UTC')::date, environment, tool_name,
            outcome, metering_policy_version, count(*), sum(billable_units),
            max(occurred_at), max(id)
       FROM mcp_tool_meter_events
      WHERE tenant_id = $1 AND shadow_period_id = $2 AND environment = $3
        AND occurred_at >= $4 AND occurred_at < $5
        AND metering_policy_version = $6
      GROUP BY tenant_id, shadow_period_id,
               (occurred_at AT TIME ZONE 'UTC')::date, environment, tool_name,
               outcome, metering_policy_version`,
    [
      input.tenantId,
      input.shadowPeriodId,
      input.environment,
      input.periodStart,
      input.periodEnd,
      MCP_SHADOW_METERING_POLICY,
    ],
  );
}

async function meterTotals(
  client: TenantScopedClient,
  input: ReconcileMcpShadowUsageInput,
): Promise<CountRow> {
  const result = await client.query<CountRow>(
    `SELECT count(*) AS request_count,
            coalesce(sum(billable_units), 0) AS billable_units,
            max(occurred_at) AS high_water_at,
            max(id) AS high_water_id
       FROM mcp_tool_meter_events
      WHERE tenant_id = $1 AND shadow_period_id = $2 AND environment = $3
        AND occurred_at >= $4 AND occurred_at < $5
        AND metering_policy_version = $6`,
    [
      input.tenantId,
      input.shadowPeriodId,
      input.environment,
      input.periodStart,
      input.periodEnd,
      MCP_SHADOW_METERING_POLICY,
    ],
  );
  return requiredRow(result.rows[0], "MCP meter totals");
}

async function rollupTotals(
  client: TenantScopedClient,
  input: ReconcileMcpShadowUsageInput,
): Promise<CountRow> {
  const result = await client.query<CountRow>(
    `SELECT coalesce(sum(request_count), 0) AS request_count,
            coalesce(sum(billable_units), 0) AS billable_units
       FROM mcp_usage_daily_rollups
      WHERE tenant_id = $1 AND shadow_period_id = $2 AND environment = $3
        AND rollup_date >= ($4::timestamptz AT TIME ZONE 'UTC')::date
        AND rollup_date < ($5::timestamptz AT TIME ZONE 'UTC')::date
        AND metering_policy_version = $6`,
    [
      input.tenantId,
      input.shadowPeriodId,
      input.environment,
      input.periodStart,
      input.periodEnd,
      MCP_SHADOW_METERING_POLICY,
    ],
  );
  return requiredRow(result.rows[0], "MCP rollup totals");
}

async function completenessTotals(
  client: TenantScopedClient,
  input: ReconcileMcpShadowUsageInput,
): Promise<CompletenessRow> {
  const result = await client.query<CompletenessRow>(
    `SELECT
       (SELECT count(*) FROM mcp_transport_tool_observations AS transport
         WHERE transport.tenant_id = $1 AND transport.shadow_period_id = $2
           AND transport.environment = $3
           AND transport.occurred_at >= $4 AND transport.occurred_at < $5
       ) AS transport_request_count,
       (SELECT count(*) FROM mcp_transport_tool_observations AS transport
          LEFT JOIN mcp_tool_meter_events AS meter
            ON meter.tenant_id = transport.tenant_id
           AND meter.request_id = transport.request_id
         WHERE transport.tenant_id = $1 AND transport.shadow_period_id = $2
           AND transport.environment = $3
           AND transport.occurred_at >= $4 AND transport.occurred_at < $5
           AND meter.request_id IS NULL
       ) AS missing_meter_count,
       (SELECT count(*) FROM mcp_tool_meter_events AS meter
          LEFT JOIN mcp_transport_tool_observations AS transport
            ON transport.tenant_id = meter.tenant_id
           AND transport.request_id = meter.request_id
         WHERE meter.tenant_id = $1 AND meter.shadow_period_id = $2
           AND meter.environment = $3
           AND meter.occurred_at >= $4 AND meter.occurred_at < $5
           AND transport.request_id IS NULL
       ) AS unexpected_meter_count,
       (SELECT count(*) FROM mcp_meter_persistence_failure_events AS failure
         WHERE failure.tenant_id = $1 AND failure.shadow_period_id = $2
           AND failure.environment = $3
           AND failure.occurred_at >= $4 AND failure.occurred_at < $5
       ) AS meter_persistence_failures,
       (SELECT max(occurred_at) FROM mcp_transport_tool_observations
         WHERE tenant_id = $1 AND shadow_period_id = $2 AND environment = $3
           AND occurred_at >= $4 AND occurred_at < $5
       ) AS high_water_at,
       (SELECT max(request_id) FROM mcp_transport_tool_observations
         WHERE tenant_id = $1 AND shadow_period_id = $2 AND environment = $3
           AND occurred_at >= $4 AND occurred_at < $5
       ) AS high_water_id`,
    [input.tenantId, input.shadowPeriodId, input.environment, input.periodStart, input.periodEnd],
  );
  return requiredRow(result.rows[0], "MCP completeness totals");
}

interface StoredReconciliationRow {
  id: string;
  status: McpShadowUsageReconciliationResult["status"];
  transport_request_count: string | number;
  raw_meter_request_count: string | number;
  raw_billable_units: string | number;
  rollup_request_count: string | number;
  rollup_billable_units: string | number;
  missing_meter_count: string | number;
  unexpected_meter_count: string | number;
  meter_persistence_failures: string | number;
  discrepancy: Record<string, { expected: number; actual: number }>;
}

function serialize(row: StoredReconciliationRow): McpShadowUsageReconciliationResult {
  return {
    id: row.id,
    status: row.status,
    transportRequestCount: toCount(row.transport_request_count, "transport request count"),
    rawMeterRequestCount: toCount(row.raw_meter_request_count, "raw meter request count"),
    rawBillableUnits: toCount(row.raw_billable_units, "raw MCP units"),
    rollupRequestCount: toCount(row.rollup_request_count, "rollup request count"),
    rollupBillableUnits: toCount(row.rollup_billable_units, "rollup MCP units"),
    missingMeterCount: toCount(row.missing_meter_count, "missing meter count"),
    unexpectedMeterCount: toCount(row.unexpected_meter_count, "unexpected meter count"),
    meterPersistenceFailures: toCount(row.meter_persistence_failures, "meter persistence failures"),
    discrepancy: row.discrepancy,
  };
}

function assertPeriod(start: Date, end: Date): void {
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) throw new Error("invalid start");
  if (!(end instanceof Date) || Number.isNaN(end.getTime()) || end <= start) {
    throw new Error("invalid end");
  }
  if (
    start.getUTCHours() !== 0 ||
    start.getUTCMinutes() !== 0 ||
    start.getUTCSeconds() !== 0 ||
    start.getUTCMilliseconds() !== 0 ||
    end.getUTCHours() !== 0 ||
    end.getUTCMinutes() !== 0 ||
    end.getUTCSeconds() !== 0 ||
    end.getUTCMilliseconds() !== 0
  ) {
    throw new Error("MCP reconciliation periods must use UTC day boundaries");
  }
}

function compare(
  discrepancy: Record<string, { expected: number; actual: number }>,
  key: string,
  expected: number,
  actual: number,
): void {
  if (expected !== actual) discrepancy[key] = { expected, actual };
}

function toCount(value: string | number, label: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${label} is not a safe count`);
  return count;
}

function requiredRow<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} query returned no row`);
  return value;
}
