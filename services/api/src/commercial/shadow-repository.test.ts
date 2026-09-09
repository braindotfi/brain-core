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
    });
    expect(pool.query).toHaveBeenLastCalledWith(
      expect.stringContaining("INSERT INTO commercial_shadow_observations"),
      expect.arrayContaining(["tier_growth_v1", "explicit"]),
    );
  });

  it("records unresolved and incomplete evidence without inventing limits", async () => {
    const pool = fakePool([
      undefined,
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
    expect(result.result.catalogResolution).toBe("unresolved");
    expect(result.executionEvidenceComplete).toBe(false);
    expect(pool.query).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.arrayContaining([null, "unresolved"]),
    );
  });

  it.each([
    [[], [{ settled_minor_units: 0, reserved_minor_units: 0, unsupported_currency_count: 0 }]],
    [[{ entity_count: 1, agent_count: 1 }], []],
  ])("rejects a missing aggregate row", async (countRows, executionRows) => {
    const pool = fakePool([undefined, countRows[0], executionRows[0]]);
    await expect(
      new CommercialShadowRepository(pool, true).observe({
        tenantId,
        shadowPeriodId: "csp_01K123456789ABCDEFGHJKMNPQ",
      }),
    ).rejects.toThrow(/query returned no row/);
  });
});

function fakePool(rows: unknown[]): Pool & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => {
    const row = rows.shift();
    return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
  });
  return { query } as unknown as Pool & { query: ReturnType<typeof vi.fn> };
}
