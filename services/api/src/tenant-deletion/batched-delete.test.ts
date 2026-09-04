import { describe, expect, it, vi } from "vitest";
import {
  assertNoProtectedTenantIds,
  batchDeleteStatement,
  deleteTableInBatches,
} from "./batched-delete.js";

describe("bounded tenant deletion", () => {
  it("materializes tableoid and ctid inside every deleting statement", () => {
    const sql = batchDeleteStatement("ledger_transactions", "owner_id");
    expect(sql).toContain("WITH deletion_batch AS MATERIALIZED");
    expect(sql).toContain("candidate.tableoid AS target_tableoid");
    expect(sql).toContain("candidate.ctid AS target_ctid");
    expect(sql).toContain("LIMIT $1");
    expect(sql).not.toContain("SKIP LOCKED");
  });

  it("runs multiple bounded statements and an ending zero probe", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });
    const deleted = await deleteTableInBatches(
      { query },
      { table: "agent_runs", column: "tenant_id", expectedRows: 5, batchSize: 2 },
    );
    expect(deleted).toBe(5);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("rejects an observed count above the captured preflight count", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 2 });
    await expect(
      deleteTableInBatches(
        { query },
        { table: "agent_runs", column: "tenant_id", expectedRows: 1, batchSize: 2 },
      ),
    ).rejects.toThrow("expected 1, got at least 2");
  });

  it("rejects unsafe identifiers before issuing SQL", () => {
    expect(() => batchDeleteStatement("tenants; DROP TABLE tenants", "id")).toThrow(
      "unsafe batch deletion identifier",
    );
  });

  it("rejects a protected tenant before deletion starts", () => {
    expect(() =>
      assertNoProtectedTenantIds(["tnt_safe", "tnt_northstar"], new Set(["tnt_northstar"])),
    ).toThrow("candidate-list contains protected tenant id: tnt_northstar");
  });
});
