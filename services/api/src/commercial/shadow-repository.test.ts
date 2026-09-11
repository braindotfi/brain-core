import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newTenantId } from "@brain/shared";
import type * as BrainShared from "@brain/shared";
import { CommercialShadowRepository } from "./shadow-repository.js";

vi.mock("@brain/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof BrainShared>();
  return {
    ...actual,
    newCommercialShadowObservationId: () => "cso_01K123456789ABCDEFGHJKMNPQ",
    withTenantScope: async (
      pool: { query: (sql: string, values?: readonly unknown[]) => Promise<unknown> },
      _tenantId: string,
      fn: (client: typeof pool) => Promise<unknown>,
    ) => fn(pool),
  };
});

const tenantId = newTenantId();

describe("CommercialShadowRepository", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fails closed while disabled", async () => {
    const repository = new CommercialShadowRepository(fakePool([]), false);
    await expect(
      repository.observe({ tenantId, shadowPeriodId: "csp_01K123456789ABCDEFGHJKMNPQ" }),
    ).rejects.toThrow("commercial shadow observation is disabled");
  });

  it("records resolved catalog evidence and a complete execution observation", async () => {
    const pool = fakePool([
      {
        id: "tier_growth_v1",
        maximum_entities: 1,
        maximum_agents: 5,
        execution_limit_minor_units: "25000000",
        api_unit_allowance: "25000",
        mcp_unit_allowance: "2500",
        api_reconciliation_run_id: "urr_api",
        api_reconciliation_status: "matched",
        api_units: "120",
        api_meter_persistence_failures: "0",
        api_period_start: "2026-10-01T00:00:00Z",
        api_period_end: "2026-10-02T00:00:00Z",
        mcp_reconciliation_run_id: "murr_mcp",
        mcp_reconciliation_status: "matched",
        mcp_units: "12",
        mcp_meter_persistence_failures: "0",
        mcp_period_start: "2026-10-01T00:00:00Z",
        mcp_period_end: "2026-10-02T00:00:00Z",
      },
      { entity_count: "1", agent_count: 2 },
      {
        settled_minor_units: 1000n,
        reserved_minor_units: "500",
        unsupported_currency_count: 0,
      },
      undefined,
    ]);
    const result = await new CommercialShadowRepository(pool, true).observe({
      tenantId,
      shadowPeriodId: "csp_01K123456789ABCDEFGHJKMNPQ",
    });

    expect(result).toMatchObject({
      id: "cso_01K123456789ABCDEFGHJKMNPQ",
      entityCount: 1,
      countedAgentCount: 2,
      executionSettledMinorUnits: 1000n,
      executionReservedMinorUnits: 500n,
      executionEvidenceComplete: true,
      apiUnits: 120n,
      mcpUnits: 12n,
      apiEvidenceComplete: true,
      mcpEvidenceComplete: true,
    });
    expect(pool.query).toHaveBeenLastCalledWith(
      expect.stringContaining("INSERT INTO commercial_shadow_observations"),
      expect.arrayContaining(["tier_growth_v1", "explicit"]),
    );
  });

  it("records unresolved API and MCP results when reconciliation is incomplete", async () => {
    const pool = fakePool([
      {
        id: "tier_growth_v1",
        maximum_entities: 1,
        maximum_agents: 5,
        execution_limit_minor_units: "25000000",
        api_unit_allowance: "25000",
        mcp_unit_allowance: "2500",
        api_reconciliation_run_id: "urr_incomplete",
        api_reconciliation_status: "incomplete",
        api_units: "1",
        api_meter_persistence_failures: "1",
        api_period_start: "2026-10-01T00:00:00Z",
        api_period_end: "2026-10-02T00:00:00Z",
        mcp_reconciliation_run_id: null,
        mcp_reconciliation_status: null,
        mcp_units: null,
        mcp_meter_persistence_failures: null,
        mcp_period_start: null,
        mcp_period_end: null,
      },
      { entity_count: 2n, agent_count: "7" },
      {
        settled_minor_units: "0",
        reserved_minor_units: 0,
        unsupported_currency_count: "1",
      },
      undefined,
    ]);
    const result = await new CommercialShadowRepository(pool, true).observe({
      tenantId,
      shadowPeriodId: "csp_01K123456789ABCDEFGHJKMNPQ",
    });
    expect(result.result.catalogResolution).toBe("explicit");
    expect(result.result.apiUnitResult).toBe("unresolved");
    expect(result.result.mcpUnitResult).toBe("unresolved");
    expect(result.executionEvidenceComplete).toBe(false);
    expect(pool.query).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.arrayContaining(["unresolved", false]),
    );
  });

  it.each([
    [[], [{ settled_minor_units: 0, reserved_minor_units: 0, unsupported_currency_count: 0 }]],
    [[{ entity_count: 1, agent_count: 1 }], []],
  ])("rejects a missing aggregate row", async (countRows, executionRows) => {
    const pool = fakePool([
      {
        id: "tier_growth_v1",
        maximum_entities: 1,
        maximum_agents: 5,
        execution_limit_minor_units: "25000000",
        api_unit_allowance: "25000",
        mcp_unit_allowance: "2500",
        api_reconciliation_run_id: null,
        api_reconciliation_status: null,
        api_units: null,
        api_meter_persistence_failures: null,
        api_period_start: null,
        api_period_end: null,
        mcp_reconciliation_run_id: null,
        mcp_reconciliation_status: null,
        mcp_units: null,
        mcp_meter_persistence_failures: null,
        mcp_period_start: null,
        mcp_period_end: null,
      },
      countRows[0],
      executionRows[0],
    ]);
    await expect(
      new CommercialShadowRepository(pool, true).observe({
        tenantId,
        shadowPeriodId: "csp_01K123456789ABCDEFGHJKMNPQ",
      }),
    ).rejects.toThrow(/query returned no row/);
  });

  it("fails closed when the tenant-bound contract is missing", async () => {
    const pool = fakePool([
      undefined,
      { entity_count: 1, agent_count: 1 },
      { settled_minor_units: 0, reserved_minor_units: 0, unsupported_currency_count: 0 },
    ]);
    await expect(
      new CommercialShadowRepository(pool, true).observe({
        tenantId,
        shadowPeriodId: "csp_01K123456789ABCDEFGHJKMNPQ",
      }),
    ).rejects.toThrow("commercial shadow contract query returned no row");
  });
});

function fakePool(rows: unknown[]): Pool & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => {
    const row = rows.shift();
    return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
  });
  return { query } as unknown as Pool & { query: ReturnType<typeof vi.fn> };
}
