import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type * as BrainShared from "@brain/shared";
import type { Principal } from "@brain/shared";
import { PostgresMcpShadowMetering } from "./metering.js";

vi.mock("@brain/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof BrainShared>();
  return {
    ...actual,
    newMcpToolMeterEventId: () => "mmtr_01M2B3C4D5E6F7G8H9JKMNPQRS",
    withTenantScope: async (
      pool: { query: (sql: string, values?: readonly unknown[]) => Promise<unknown> },
      _tenantId: string,
      fn: (client: typeof pool) => Promise<unknown>,
    ) => fn(pool),
  };
});

const TARGET = "tnt_01M2B3C4D5E6F7G8H9JKMNPQRS";
const OTHER = "tnt_01M2B3C4D5E6F7G8H9JKMNPQRT";

function principal(tenantId = TARGET): Principal {
  return {
    id: "agent_01M2B3C4D5E6F7G8H9JKMNPQRS",
    type: "agent",
    tenantId,
    scopes: [],
    tokenId: "token_01M2B3C4D5E6F7G8H9JKMNPQRS",
    expiresAt: 1_800_000_000,
  };
}

describe("PostgresMcpShadowMetering", () => {
  it("does not query or record another tenant", async () => {
    const pool = fakePool([]);
    const result = await new PostgresMcpShadowMetering(pool, TARGET, "live").observeTransport({
      requestId: "req_other",
      principal: principal(OTHER),
      toolName: "ledger.accounts.list",
      limiterDecision: true,
      occurredAt: new Date("2026-10-01T01:00:00Z"),
    });
    expect(result).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("records independent transport evidence against the active contract", async () => {
    const pool = fakePool([{ shadow_period_id: "csp_october" }]);
    const result = await new PostgresMcpShadowMetering(pool, TARGET, "live").observeTransport({
      requestId: "req_1",
      principal: principal(),
      toolName: "ledger.accounts.list",
      limiterDecision: true,
      occurredAt: new Date("2026-10-01T01:00:00Z"),
    });
    expect(result).toMatchObject({
      tenantId: TARGET,
      shadowPeriodId: "csp_october",
      requestId: "req_1",
      toolName: "ledger.accounts.list",
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO mcp_transport_tool_observations"),
      expect.arrayContaining([TARGET, "req_1", "ledger.accounts.list", true]),
    );
  });

  it("fails closed for the target tenant without an active contract", async () => {
    const pool = fakePool([]);
    await expect(
      new PostgresMcpShadowMetering(pool, TARGET, "live").observeTransport({
        requestId: "req_1",
        principal: principal(),
        toolName: "ledger.accounts.list",
        limiterDecision: true,
        occurredAt: new Date("2026-10-01T01:00:00Z"),
      }),
    ).rejects.toThrow("active tenant-bound commercial shadow contract is missing");
  });

  it("assigns one unit only to a fulfilled tool call", async () => {
    const pool = fakePool([undefined, undefined]);
    const metering = new PostgresMcpShadowMetering(pool, TARGET, "live");
    const binding = {
      tenantId: TARGET,
      shadowPeriodId: "csp_october",
      environment: "live" as const,
      requestId: "req_1",
      principalType: "agent" as const,
      principalId: principal().id,
      toolName: "ledger.accounts.list",
      occurredAt: new Date("2026-10-01T01:00:00Z"),
    };
    await metering.recordTool({
      binding,
      statusCode: 200,
      outcome: "success",
      rejectionReason: null,
    });
    await metering.recordTool({
      binding: { ...binding, requestId: "req_2" },
      statusCode: 200,
      outcome: "scope_rejected",
      rejectionReason: "scope_rejected",
    });
    expect(pool.query.mock.calls[0]?.[1]).toContain(1);
    expect(pool.query.mock.calls[1]?.[1]).toContain(0);
  });
});

function fakePool(rows: unknown[]): Pool & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => {
    const row = rows.shift();
    return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
  });
  return { query } as unknown as Pool & { query: ReturnType<typeof vi.fn> };
}
