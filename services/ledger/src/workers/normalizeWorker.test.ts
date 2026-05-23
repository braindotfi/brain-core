import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { newTenantId } from "@brain/shared";
import { recordNormalizationResult } from "./normalizeWorker.js";

function fakePool(): { pool: Pool; queries: string[] } {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      queries.push(text.trim().split("\n")[0]!.trim());
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, queries };
}

describe("recordNormalizationResult", () => {
  it("writes normalization_log inside a tenant-scoped transaction", async () => {
    const { pool, queries } = fakePool();
    const tenantId = newTenantId();
    await recordNormalizationResult(pool, { id: "prs_1", tenant_id: tenantId }, null);

    const setIdx = queries.findIndex((q) => q.includes("set_config('app.tenant_id'"));
    const insIdx = queries.findIndex((q) => q.includes("INSERT INTO normalization_log"));
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(insIdx).toBeGreaterThan(setIdx);
    expect(queries).toContain("COMMIT");
  });
});
