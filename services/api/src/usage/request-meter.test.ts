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
      effectiveTierId: "sandbox_demo_v1",
      entitlementVersion: 1,
      rateLimitTenantCount: 7,
      rateLimitTenantValue: 6000,
      rateLimitRejectedBy: null,
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
      event.effectiveTierId,
      event.entitlementVersion,
      event.rateLimitTenantCount,
      event.rateLimitTenantValue,
      event.rateLimitRejectedBy,
      "requests_v1_shadow",
      0,
    ]);
  });

  it("measures only successful live production traffic under the shadow policy", async () => {
    const values: unknown[][] = [];
    const client = {
      query: async (sql: string, parameters: unknown[] = []) => {
        if (sql.includes("INSERT INTO api_request_meter_events")) values.push(parameters);
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    };
    const meter = new PostgresApiRequestMeter({ connect: async () => client } as never);
    const base: ApiRequestMeterEvent = {
      requestId: "req_billable",
      tenantId: "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ",
      keyId: "akey_billable",
      occurredAt: new Date("2026-09-01T12:00:00.000Z"),
      environment: "live",
      accessStage: "production",
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
      effectiveTierId: "scale_v1",
      entitlementVersion: 1,
      rateLimitTenantCount: 1,
      rateLimitTenantValue: 6000,
      rateLimitRejectedBy: null,
    };

    await meter.record(base);
    await meter.record({ ...base, requestId: "req_sandbox", environment: "sandbox" });
    await meter.record({
      ...base,
      requestId: "req_failure",
      statusCode: 500,
      outcome: "server_error",
    });

    expect(values.map((row) => row.slice(-2))).toEqual([
      ["requests_v1_shadow", 1],
      ["requests_v1_shadow", 0],
      ["requests_v1_shadow", 0],
    ]);
  });
});
