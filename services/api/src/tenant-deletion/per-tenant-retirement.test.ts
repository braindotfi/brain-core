import { describe, expect, it, vi } from "vitest";
import {
  assertTenantReconciliationEmpty,
  captureTenantReconciliationCounts,
  tenantReconciliationCountStatement,
} from "./per-tenant-retirement.js";

describe("per-tenant reconciliation", () => {
  it("builds only a direct parameterized tenant filter", () => {
    expect(tenantReconciliationCountStatement("audit_events", "tenant_id")).toBe(
      "SELECT COUNT(*)::bigint AS count FROM audit_events WHERE tenant_id = $1",
    );
    expect(() =>
      tenantReconciliationCountStatement("audit_events; DROP TABLE tenants", "id"),
    ).toThrow("invalid tenant reconciliation identifier");
  });

  it("captures each count using the tenant id parameter", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ count: "8404" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });
    await expect(
      captureTenantReconciliationCounts(
        { query },
        [
          { table: "audit_events", column: "tenant_id" },
          { table: "proposals", column: "tenant_id" },
        ],
        "tnt_test",
      ),
    ).resolves.toEqual({ audit_events: 8404, proposals: 0 });
    expect(query).toHaveBeenNthCalledWith(
      1,
      "SELECT COUNT(*)::bigint AS count FROM audit_events WHERE tenant_id = $1",
      ["tnt_test"],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT COUNT(*)::bigint AS count FROM proposals WHERE tenant_id = $1",
      ["tnt_test"],
    );
  });

  it("fails closed when any direct post-delete count remains", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ count: "1" }], rowCount: 1 });
    await expect(
      assertTenantReconciliationEmpty(
        { query },
        [{ table: "proposals", column: "tenant_id" }],
        "tnt_test",
      ),
    ).rejects.toThrow('tenant rows remain after delete: [["proposals",1]]');
  });
});
