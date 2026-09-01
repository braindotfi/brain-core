import { describe, expect, it } from "vitest";
import { closeShadowUsagePeriod, reconcileUsagePeriod } from "./billing-service.js";

const operatorActor = ["github", "operator"].join(":");

function fakePool(options: {
  rawRequests?: number;
  rawUnits?: number;
  rawLimiterDecisions?: number;
  rollupRequests?: number;
  rollupUnits?: number;
  reconciliation?: Record<string, unknown>;
}) {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes("WHERE tenant_id = $1 AND idempotency_key = $2")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("count(*) AS request_count") && sql.includes("api_request_meter_events")) {
        return {
          rows: [
            {
              request_count: options.rawRequests ?? 3,
              billable_units: options.rawUnits ?? 2,
              limiter_decision_count: options.rawLimiterDecisions ?? 3,
              high_water_at: "2026-09-02T00:00:00.000Z",
              high_water_id: "mtr_high",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("sum(request_count)") && sql.includes("api_usage_daily_rollups")) {
        return {
          rows: [
            {
              request_count: options.rollupRequests ?? 3,
              billable_units: options.rollupUnits ?? 2,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM api_usage_reconciliation_runs") && sql.includes("WHERE id = $1")) {
        return {
          rows: [
            options.reconciliation ?? {
              environment: "live",
              period_start: "2026-09-01T00:00:00.000Z",
              period_end: "2026-10-01T00:00:00.000Z",
              metering_policy_version: "requests_v1_shadow",
              raw_request_count: 3,
              raw_billable_units: 2,
              status: "matched",
              meter_persistence_failures: 0,
              source_high_water_at: "2026-09-02T00:00:00.000Z",
              source_high_water_id: "mtr_high",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT id FROM api_billing_periods")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as never, queries };
}

const reconcileInput = {
  tenantId: "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ",
  environment: "live" as const,
  periodStart: new Date("2026-09-01T00:00:00.000Z"),
  periodEnd: new Date("2026-10-01T00:00:00.000Z"),
  idempotencyKey: "github-run-123",
  actor: operatorActor,
  gatewayRequestCount: 3,
  limiterDecisionCount: 3,
  meterPersistenceFailures: 0,
};

describe("usage billing foundation", () => {
  it("rebuilds rollups and records a matched shadow reconciliation", async () => {
    const { pool, queries } = fakePool({});
    const result = await reconcileUsagePeriod(pool, reconcileInput);

    expect(result).toMatchObject({
      status: "matched",
      rawRequestCount: 3,
      rawBillableUnits: 2,
      rollupRequestCount: 3,
      rollupBillableUnits: 2,
      discrepancy: {},
    });
    expect(queries.some(({ sql }) => sql.includes("DELETE FROM api_usage_daily_rollups"))).toBe(
      true,
    );
    expect(
      queries.some(({ sql }) => sql.includes("INSERT INTO api_usage_reconciliation_runs")),
    ).toBe(true);
  });

  it("fails reconciliation when gateway evidence or persistence completeness differs", async () => {
    const { pool } = fakePool({});
    const result = await reconcileUsagePeriod(pool, {
      ...reconcileInput,
      gatewayRequestCount: 4,
      meterPersistenceFailures: 1,
    });

    expect(result.status).toBe("incomplete");
    expect(result.discrepancy).toMatchObject({
      gateway_requests: { expected: 3, actual: 4 },
      meter_persistence_failures: { expected: 0, actual: 1 },
    });
  });

  it("closes a matched period in zero-charge shadow mode", async () => {
    const { pool, queries } = fakePool({});
    const result = await closeShadowUsagePeriod(pool, {
      tenantId: reconcileInput.tenantId,
      environment: "live",
      reconciliationRunId: "urr_01M0KHRVY3RT3EXN7WT2SPDFMZ",
      actor: operatorActor,
      reason: "approved shadow close",
    });

    expect(result).toMatchObject({ existing: false, chargeableUnits: 0 });
    const insert = queries.find(({ sql }) => sql.includes("INSERT INTO api_billing_periods"));
    expect(insert?.sql).toContain("'shadow_closed'");
    expect(insert?.sql).toContain("$8, 0");
  });

  it("refuses to close an incomplete reconciliation", async () => {
    const { pool } = fakePool({
      reconciliation: {
        environment: "live",
        status: "incomplete",
        meter_persistence_failures: 1,
      },
    });
    await expect(
      closeShadowUsagePeriod(pool, {
        tenantId: reconcileInput.tenantId,
        environment: "live",
        reconciliationRunId: "urr_incomplete",
        actor: operatorActor,
        reason: "must fail",
      }),
    ).rejects.toThrow("only a complete matched reconciliation run can close a period");
  });
});
