import type { Pool } from "pg";
import {
  newApiBillingAdjustmentId,
  newApiBillingPeriodId,
  newApiUsageReconciliationRunId,
  type TenantScopedClient,
  withTenantScope,
} from "@brain/shared";
import { SHADOW_REQUEST_POLICY_VERSION } from "./billing-policy.js";

export interface ReconcileUsageInput {
  tenantId: string;
  environment: "sandbox" | "live";
  periodStart: Date;
  periodEnd: Date;
  idempotencyKey: string;
  actor: string;
}

export interface UsageReconciliationResult {
  id: string;
  status: "matched" | "mismatch" | "incomplete";
  rawRequestCount: number;
  rawBillableUnits: number;
  rawLimiterDecisionCount: number;
  rollupRequestCount: number;
  rollupBillableUnits: number;
  discrepancy: Record<string, { expected: number; actual: number }>;
}

interface CountRow {
  request_count: string | number;
  billable_units: string | number;
  limiter_decision_count?: string | number;
  high_water_at?: Date | string | null;
  high_water_id?: string | null;
}

interface GatewayObservationTotalsRow {
  gateway_request_count: string | number;
  limiter_decision_count: string | number;
  missing_meter_count: string | number;
  explicit_meter_failure_count: string | number;
}

export async function reconcileUsagePeriod(
  pool: Pool,
  input: ReconcileUsageInput,
): Promise<UsageReconciliationResult> {
  assertPeriod(input.periodStart, input.periodEnd);

  return withTenantScope(pool, input.tenantId, async (client) => {
    const existing = await client.query<{
      id: string;
      status: UsageReconciliationResult["status"];
      raw_request_count: string | number;
      raw_billable_units: string | number;
      raw_limiter_decision_count: string | number;
      rollup_request_count: string | number;
      rollup_billable_units: string | number;
      discrepancy: UsageReconciliationResult["discrepancy"];
    }>(
      `SELECT id, status, raw_request_count, raw_billable_units,
              raw_limiter_decision_count, rollup_request_count,
              rollup_billable_units, discrepancy
         FROM api_usage_reconciliation_runs
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [input.tenantId, input.idempotencyKey],
    );
    if (existing.rows[0] !== undefined) return serializeReconciliation(existing.rows[0]);

    await rebuildDailyRollups(client, input);
    const raw = await rawTotals(client, input);
    const rollup = await rollupTotals(client, input);
    const observed = await gatewayObservationTotals(client, input);
    const rawRequestCount = Number(raw.request_count);
    const rawBillableUnits = Number(raw.billable_units);
    const rawLimiterDecisionCount = Number(raw.limiter_decision_count ?? 0);
    const rollupRequestCount = Number(rollup.request_count);
    const rollupBillableUnits = Number(rollup.billable_units);
    const gatewayRequestCount = Number(observed.gateway_request_count);
    const limiterDecisionCount = Number(observed.limiter_decision_count);
    const missingMeterCount = Number(observed.missing_meter_count);
    const explicitMeterFailureCount = Number(observed.explicit_meter_failure_count);
    const meterPersistenceFailures = Math.max(missingMeterCount, explicitMeterFailureCount);
    const discrepancy: UsageReconciliationResult["discrepancy"] = {};
    compare(discrepancy, "rollup_requests", rawRequestCount, rollupRequestCount);
    compare(discrepancy, "rollup_units", rawBillableUnits, rollupBillableUnits);
    compare(discrepancy, "gateway_requests", rawRequestCount, gatewayRequestCount);
    compare(discrepancy, "limiter_decisions", rawLimiterDecisionCount, limiterDecisionCount);
    compare(discrepancy, "explicit_meter_failures", missingMeterCount, explicitMeterFailureCount);
    const status =
      meterPersistenceFailures > 0
        ? "incomplete"
        : Object.keys(discrepancy).length === 0
          ? "matched"
          : "mismatch";
    if (meterPersistenceFailures > 0) {
      discrepancy.meter_persistence_failures = {
        expected: 0,
        actual: meterPersistenceFailures,
      };
    }
    const id = newApiUsageReconciliationRunId();
    await client.query(
      `INSERT INTO api_usage_reconciliation_runs (
         id, idempotency_key, tenant_id, environment, period_start, period_end,
         metering_policy_version, raw_request_count, raw_billable_units,
         raw_limiter_decision_count, rollup_request_count, rollup_billable_units,
         gateway_request_count, limiter_decision_count, meter_persistence_failures,
         status, discrepancy, source_high_water_at, source_high_water_id, actor
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17::jsonb, $18, $19, $20
       )`,
      [
        id,
        input.idempotencyKey,
        input.tenantId,
        input.environment,
        input.periodStart,
        input.periodEnd,
        SHADOW_REQUEST_POLICY_VERSION,
        rawRequestCount,
        rawBillableUnits,
        rawLimiterDecisionCount,
        rollupRequestCount,
        rollupBillableUnits,
        gatewayRequestCount,
        limiterDecisionCount,
        meterPersistenceFailures,
        status,
        JSON.stringify(discrepancy),
        raw.high_water_at ?? null,
        raw.high_water_id ?? null,
        input.actor,
      ],
    );
    return {
      id,
      status,
      rawRequestCount,
      rawBillableUnits,
      rawLimiterDecisionCount,
      rollupRequestCount,
      rollupBillableUnits,
      discrepancy,
    };
  });
}

export interface CloseUsagePeriodInput {
  tenantId: string;
  environment: "sandbox" | "live";
  reconciliationRunId: string;
  actor: string;
  reason: string;
}

export async function closeShadowUsagePeriod(pool: Pool, input: CloseUsagePeriodInput) {
  return withTenantScope(pool, input.tenantId, async (client) => {
    const { rows } = await client.query<{
      environment: "sandbox" | "live";
      period_start: Date | string;
      period_end: Date | string;
      metering_policy_version: string;
      raw_request_count: string | number;
      raw_billable_units: string | number;
      status: string;
      meter_persistence_failures: string | number;
      source_high_water_at: Date | string | null;
      source_high_water_id: string | null;
    }>(
      `SELECT environment, period_start, period_end, metering_policy_version,
              raw_request_count, raw_billable_units, status,
              meter_persistence_failures, source_high_water_at, source_high_water_id
         FROM api_usage_reconciliation_runs
        WHERE id = $1 AND tenant_id = $2`,
      [input.reconciliationRunId, input.tenantId],
    );
    const run = rows[0];
    if (run === undefined) throw new Error("reconciliation run not found for tenant");
    if (run.environment !== input.environment)
      throw new Error("reconciliation environment mismatch");
    if (run.status !== "matched" || Number(run.meter_persistence_failures) !== 0) {
      throw new Error("only a complete matched reconciliation run can close a period");
    }
    if (run.metering_policy_version !== SHADOW_REQUEST_POLICY_VERSION) {
      throw new Error("only the approved shadow policy can be closed by this command");
    }
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM api_billing_periods
        WHERE tenant_id = $1 AND environment = $2
          AND period_start = $3 AND period_end = $4`,
      [input.tenantId, input.environment, run.period_start, run.period_end],
    );
    if (existing.rows[0] !== undefined) {
      return { id: existing.rows[0].id, existing: true, chargeableUnits: 0 };
    }
    const id = newApiBillingPeriodId();
    await client.query(
      `INSERT INTO api_billing_periods (
         id, tenant_id, environment, period_start, period_end, mode,
         metering_policy_version, request_count, billable_units, chargeable_units,
         reconciliation_run_id, source_high_water_at, source_high_water_id,
         closed_by, close_reason
       ) VALUES ($1, $2, $3, $4, $5, 'shadow_closed', $6, $7, $8, 0,
                 $9, $10, $11, $12, $13)`,
      [
        id,
        input.tenantId,
        input.environment,
        run.period_start,
        run.period_end,
        run.metering_policy_version,
        Number(run.raw_request_count),
        Number(run.raw_billable_units),
        input.reconciliationRunId,
        run.source_high_water_at,
        run.source_high_water_id,
        input.actor,
        input.reason,
      ],
    );
    return { id, existing: false, chargeableUnits: 0 };
  });
}

export async function addUsageAdjustment(
  pool: Pool,
  input: {
    tenantId: string;
    billingPeriodId: string;
    unitDelta: number;
    reason: string;
    actor: string;
  },
) {
  if (!Number.isSafeInteger(input.unitDelta) || input.unitDelta === 0) {
    throw new Error("unitDelta must be a nonzero safe integer");
  }
  return withTenantScope(pool, input.tenantId, async (client) => {
    const period = await client.query<{ id: string }>(
      `SELECT id FROM api_billing_periods WHERE id = $1 AND tenant_id = $2`,
      [input.billingPeriodId, input.tenantId],
    );
    if (period.rows[0] === undefined) throw new Error("billing period not found for tenant");
    const id = newApiBillingAdjustmentId();
    await client.query(
      `INSERT INTO api_billing_adjustments (
         id, tenant_id, billing_period_id, unit_delta, reason, actor
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, input.tenantId, input.billingPeriodId, input.unitDelta, input.reason, input.actor],
    );
    return { id };
  });
}

async function rebuildDailyRollups(
  client: TenantScopedClient,
  input: ReconcileUsageInput,
): Promise<void> {
  await client.query(
    `DELETE FROM api_usage_daily_rollups
      WHERE tenant_id = $1 AND environment = $2
        AND rollup_date >= ($3::timestamptz AT TIME ZONE 'UTC')::date
        AND rollup_date < ($4::timestamptz AT TIME ZONE 'UTC')::date`,
    [input.tenantId, input.environment, input.periodStart, input.periodEnd],
  );
  await client.query(
    `INSERT INTO api_usage_daily_rollups (
       tenant_id, rollup_date, key_id, environment, method, operation_id,
       required_scope, product_family, outcome, metering_policy_version,
       request_count, billable_units, source_last_occurred_at, source_last_event_id
     )
     SELECT tenant_id, (occurred_at AT TIME ZONE 'UTC')::date, key_id, environment,
            method, operation_id, coalesce(required_scope, 'unclassified'),
            coalesce(product_family, 'unclassified'), outcome,
            metering_policy_version, count(*), sum(billable_units),
            max(occurred_at), max(id)
       FROM api_request_meter_events
      WHERE tenant_id = $1 AND environment = $2
        AND occurred_at >= $3 AND occurred_at < $4
      GROUP BY tenant_id, (occurred_at AT TIME ZONE 'UTC')::date, key_id,
               environment, method, operation_id, coalesce(required_scope, 'unclassified'),
               coalesce(product_family, 'unclassified'), outcome,
               metering_policy_version`,
    [input.tenantId, input.environment, input.periodStart, input.periodEnd],
  );
}

async function rawTotals(
  client: TenantScopedClient,
  input: ReconcileUsageInput,
): Promise<CountRow> {
  const { rows } = await client.query<CountRow>(
    `SELECT count(*) AS request_count,
            coalesce(sum(billable_units), 0) AS billable_units,
            count(*) FILTER (WHERE rate_limit_count IS NOT NULL) AS limiter_decision_count,
            max(occurred_at) AS high_water_at,
            max(id) AS high_water_id
       FROM api_request_meter_events
      WHERE tenant_id = $1 AND environment = $2
        AND occurred_at >= $3 AND occurred_at < $4
        AND metering_policy_version = $5`,
    [
      input.tenantId,
      input.environment,
      input.periodStart,
      input.periodEnd,
      SHADOW_REQUEST_POLICY_VERSION,
    ],
  );
  return rows[0] ?? { request_count: 0, billable_units: 0, limiter_decision_count: 0 };
}

async function rollupTotals(
  client: TenantScopedClient,
  input: ReconcileUsageInput,
): Promise<CountRow> {
  const { rows } = await client.query<CountRow>(
    `SELECT coalesce(sum(request_count), 0) AS request_count,
            coalesce(sum(billable_units), 0) AS billable_units
       FROM api_usage_daily_rollups
      WHERE tenant_id = $1 AND environment = $2
        AND rollup_date >= ($3::timestamptz AT TIME ZONE 'UTC')::date
        AND rollup_date < ($4::timestamptz AT TIME ZONE 'UTC')::date
        AND metering_policy_version = $5`,
    [
      input.tenantId,
      input.environment,
      input.periodStart,
      input.periodEnd,
      SHADOW_REQUEST_POLICY_VERSION,
    ],
  );
  return rows[0] ?? { request_count: 0, billable_units: 0 };
}

async function gatewayObservationTotals(
  client: TenantScopedClient,
  input: ReconcileUsageInput,
): Promise<GatewayObservationTotalsRow> {
  const { rows } = await client.query<GatewayObservationTotalsRow>(
    `SELECT count(*) AS gateway_request_count,
            count(*) FILTER (WHERE observation.limiter_decision) AS limiter_decision_count,
            count(*) FILTER (WHERE meter.request_id IS NULL) AS missing_meter_count,
            (
              SELECT count(*)
                FROM api_meter_persistence_failure_events failure
               WHERE failure.tenant_id = $1 AND failure.environment = $2
                 AND failure.occurred_at >= $3 AND failure.occurred_at < $4
            ) AS explicit_meter_failure_count
       FROM api_gateway_request_observations observation
       LEFT JOIN api_request_meter_events meter
         ON meter.tenant_id = observation.tenant_id
        AND meter.request_id = observation.request_id
      WHERE observation.tenant_id = $1 AND observation.environment = $2
        AND observation.occurred_at >= $3 AND observation.occurred_at < $4`,
    [input.tenantId, input.environment, input.periodStart, input.periodEnd],
  );
  return (
    rows[0] ?? {
      gateway_request_count: 0,
      limiter_decision_count: 0,
      missing_meter_count: 0,
      explicit_meter_failure_count: 0,
    }
  );
}

function compare(
  target: UsageReconciliationResult["discrepancy"],
  key: string,
  expected: number,
  actual: number,
): void {
  if (expected !== actual) target[key] = { expected, actual };
}

function serializeReconciliation(row: {
  id: string;
  status: UsageReconciliationResult["status"];
  raw_request_count: string | number;
  raw_billable_units: string | number;
  raw_limiter_decision_count: string | number;
  rollup_request_count: string | number;
  rollup_billable_units: string | number;
  discrepancy: UsageReconciliationResult["discrepancy"];
}): UsageReconciliationResult {
  return {
    id: row.id,
    status: row.status,
    rawRequestCount: Number(row.raw_request_count),
    rawBillableUnits: Number(row.raw_billable_units),
    rawLimiterDecisionCount: Number(row.raw_limiter_decision_count),
    rollupRequestCount: Number(row.rollup_request_count),
    rollupBillableUnits: Number(row.rollup_billable_units),
    discrepancy: row.discrepancy,
  };
}

function assertPeriod(start: Date, end: Date): void {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw new Error("period must contain valid ascending timestamps");
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
    throw new Error("reconciliation periods must use UTC day boundaries");
  }
}
