import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type * as BrainShared from "@brain/shared";
import { reconcileMcpShadowUsage } from "./mcp-usage-reconciliation.js";

vi.mock("@brain/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof BrainShared>();
  return {
    ...actual,
    newMcpUsageReconciliationRunId: () => "murr_01M2B3C4D5E6F7G8H9JKMNPQRS",
    withTenantScope: async (
      pool: { query: (sql: string, values?: readonly unknown[]) => Promise<unknown> },
      _tenantId: string,
      fn: (client: typeof pool) => Promise<unknown>,
    ) => fn(pool),
  };
});

const input = {
  tenantId: "tnt_01M2B3C4D5E6F7G8H9JKMNPQRS",
  shadowPeriodId: "csp_october",
  environment: "live" as const,
  periodStart: new Date("2026-10-01T00:00:00Z"),
  periodEnd: new Date("2026-10-02T00:00:00Z"),
  idempotencyKey: "commercial-shadow:2026-10-02",
  actor: "commercial_shadow_operator",
};

describe("reconcileMcpShadowUsage", () => {
  it("records matched evidence only when transport, meter, and rollup agree", async () => {
    const pool = fakePool([
      [],
      [{ ok: 1 }],
      [],
      [],
      [{ request_count: "3", billable_units: "2", high_water_at: null, high_water_id: null }],
      [{ request_count: "3", billable_units: "2" }],
      [
        {
          transport_request_count: "3",
          missing_meter_count: "0",
          unexpected_meter_count: "0",
          meter_persistence_failures: "0",
          high_water_at: null,
          high_water_id: null,
        },
      ],
      [],
    ]);
    await expect(reconcileMcpShadowUsage(pool, input)).resolves.toMatchObject({
      status: "matched",
      transportRequestCount: 3,
      rawMeterRequestCount: 3,
      rawBillableUnits: 2,
      rollupRequestCount: 3,
      rollupBillableUnits: 2,
      discrepancy: {},
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO mcp_usage_reconciliation_runs"),
      expect.arrayContaining(["matched", "{}"]),
    );
  });

  it("marks missing rows and explicit append failures incomplete", async () => {
    const pool = fakePool([
      [],
      [{ ok: 1 }],
      [],
      [],
      [{ request_count: "2", billable_units: "2", high_water_at: null, high_water_id: null }],
      [{ request_count: "2", billable_units: "2" }],
      [
        {
          transport_request_count: "3",
          missing_meter_count: "1",
          unexpected_meter_count: "0",
          meter_persistence_failures: "1",
          high_water_at: null,
          high_water_id: null,
        },
      ],
      [],
    ]);
    const result = await reconcileMcpShadowUsage(pool, input);
    expect(result.status).toBe("incomplete");
    expect(result.discrepancy).toMatchObject({
      transport_requests: { expected: 3, actual: 2 },
      missing_meter_rows: { expected: 0, actual: 1 },
      meter_persistence_failures: { expected: 0, actual: 1 },
    });
  });

  it("rejects non-UTC reconciliation boundaries", async () => {
    await expect(
      reconcileMcpShadowUsage(fakePool([]), {
        ...input,
        periodEnd: new Date("2026-10-02T00:00:01Z"),
      }),
    ).rejects.toThrow("UTC day boundaries");
  });
});

function fakePool(resultRows: unknown[][]): Pool & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rows: resultRows.shift() ?? [], rowCount: 0 }));
  return { query } as unknown as Pool & { query: ReturnType<typeof vi.fn> };
}
