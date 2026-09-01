import { describe, expect, it } from "vitest";
import type { ApiRequestMeterEvent } from "@brain/shared";
import { PostgresApiRequestMeter } from "./request-meter.js";

describe("PostgresApiRequestMeter", () => {
  it("appends through tenant RLS scope with tenant-local request idempotency", async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client = {
      query: async (sql: string, values: readonly unknown[] = []) => {
        queries.push({ sql, values });
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    };
    const meter = new PostgresApiRequestMeter({ connect: async () => client } as never);
    const event: ApiRequestMeterEvent = {
      requestId: "req_phase1",
      tenantId: "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ",
      keyId: "akey_phase1",
      occurredAt: new Date("2026-09-01T12:00:00.000Z"),
      environment: "sandbox",
      accessStage: "demo",
      method: "GET",
      routeTemplate: "/v1/ledger/accounts",
      operationId: "listAccounts",
      requiredScope: "ledger:read",
      productFamily: "ledger",
      statusCode: 200,
      outcome: "success",
      rejectionReason: null,
      rateLimitCount: 1,
      rateLimitValue: 600,
      rateLimitWindowSeconds: 60,
    };

    await meter.record(event);

    expect(queries.map((query) => query.sql)).toEqual([
      "BEGIN",
      "SELECT set_config('app.tenant_id', $1, true)",
      expect.stringContaining("INSERT INTO api_request_meter_events"),
      "COMMIT",
    ]);
    expect(queries[1]?.values).toEqual([event.tenantId]);
    expect(queries[2]?.sql).toContain("ON CONFLICT (tenant_id, request_id) DO NOTHING");
    expect(queries[2]?.values).toEqual([
      expect.stringMatching(/^mtr_/),
      event.requestId,
      event.tenantId,
      event.keyId,
      event.occurredAt,
      event.environment,
      event.accessStage,
      event.method,
      event.routeTemplate,
      event.operationId,
      event.requiredScope,
      event.productFamily,
      event.statusCode,
      event.outcome,
      event.rejectionReason,
      event.rateLimitCount,
      event.rateLimitValue,
      event.rateLimitWindowSeconds,
    ]);
  });
});
