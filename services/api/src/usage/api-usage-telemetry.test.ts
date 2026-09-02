import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PostgresApiUsageTelemetry } from "./api-usage-telemetry.js";

function recordingPool() {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as never, queries };
}

const occurredAt = new Date("2026-09-02T12:00:00.000Z");

describe("PostgresApiUsageTelemetry", () => {
  it("uses the production metrics emitter and durable telemetry in API composition", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(main).toContain("const metrics = createMetrics({");
    expect(main).not.toContain("const metrics = new MockMetrics()");
    expect(main).toContain("new PostgresApiUsageTelemetry(pool)");
  });

  it("persists an idempotent gateway observation before request handling", async () => {
    const { pool, queries } = recordingPool();
    const telemetry = new PostgresApiUsageTelemetry(pool);

    await telemetry.recordGateway({
      requestId: "req_gateway",
      tenantId: "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ",
      keyId: "akey_01M0KHRVY3RT3EXN7WT2SPDFMZ",
      environment: "live",
      occurredAt,
      limiterDecision: true,
    });

    const insert = queries.find(({ sql }) =>
      sql.includes("INSERT INTO api_gateway_request_observations"),
    );
    expect(insert?.sql).toContain("ON CONFLICT (tenant_id, request_id) DO NOTHING");
    expect(insert?.values).toContain(occurredAt);
    expect(insert?.values).toContain(true);
  });

  it("persists explicit meter failures in a separate append-only stream", async () => {
    const { pool, queries } = recordingPool();
    const telemetry = new PostgresApiUsageTelemetry(pool);

    await telemetry.recordMeterFailure({
      requestId: "req_failure",
      tenantId: "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ",
      keyId: "akey_01M0KHRVY3RT3EXN7WT2SPDFMZ",
      environment: "sandbox",
      occurredAt,
    });

    expect(
      queries.some(({ sql }) => sql.includes("INSERT INTO api_meter_persistence_failure_events")),
    ).toBe(true);
  });
});
