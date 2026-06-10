import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { newTenantId } from "@brain/shared";
import { recordNormalizationResult } from "./normalizeWorker.js";

function fakePool(): { pool: Pool; queries: string[]; values: unknown[][] } {
  const queries: string[] = [];
  const values: unknown[][] = [];
  const client = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      queries.push(text.trim().split("\n")[0]!.trim());
      values.push(params ?? []);
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, queries, values };
}

describe("recordNormalizationResult", () => {
  it("writes normalization_log inside a tenant-scoped transaction, recording the row's parser", async () => {
    const { pool, queries, values } = fakePool();
    const tenantId = newTenantId();
    await recordNormalizationResult(
      pool,
      { id: "prs_1", tenant_id: tenantId, parser: "doc_obligation_v1" },
      null,
    );

    const setIdx = queries.findIndex((q) => q.includes("set_config('app.tenant_id'"));
    const insIdx = queries.findIndex((q) => q.includes("INSERT INTO normalization_log"));
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(insIdx).toBeGreaterThan(setIdx);
    expect(queries).toContain("COMMIT");
    // The actual parser lands in the log, not a hardcoded plaid_tx_v1.
    expect(values[insIdx]).toEqual(["prs_1", tenantId, "doc_obligation_v1", null]);
  });
});
