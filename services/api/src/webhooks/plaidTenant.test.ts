import { describe, it, expect, vi } from "vitest";
import { createPlaidTenantResolver } from "./plaidTenant.js";

function makePool(rows: Array<{ tenant_id: string }>) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

const headers = {};

describe("createPlaidTenantResolver", () => {
  it("returns tenant_id for a known item_id", async () => {
    const pool = makePool([{ tenant_id: "tnt_abc" }]);
    const resolver = createPlaidTenantResolver(pool as never);
    const body = Buffer.from(JSON.stringify({ item_id: "item_123" }));

    const tenantId = await resolver("plaid", body, headers);
    expect(tenantId).toBe("tnt_abc");
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("raw_plaid_items"), [
      "item_123",
    ]);
  });

  it("throws auth_tenant_mismatch when item_id not found", async () => {
    const pool = makePool([]);
    const resolver = createPlaidTenantResolver(pool as never);
    const body = Buffer.from(JSON.stringify({ item_id: "unknown" }));

    await expect(resolver("plaid", body, headers)).rejects.toMatchObject({
      code: "auth_tenant_mismatch",
    });
  });

  it("throws request_body_invalid when item_id is absent", async () => {
    const pool = makePool([]);
    const resolver = createPlaidTenantResolver(pool as never);
    const body = Buffer.from(JSON.stringify({ webhook_type: "TRANSACTIONS" }));

    await expect(resolver("plaid", body, headers)).rejects.toMatchObject({
      code: "request_body_invalid",
    });
  });

  it("throws request_body_invalid for non-JSON body", async () => {
    const pool = makePool([]);
    const resolver = createPlaidTenantResolver(pool as never);
    const body = Buffer.from("not json");

    await expect(resolver("plaid", body, headers)).rejects.toMatchObject({
      code: "request_body_invalid",
    });
  });

  it("throws auth_tenant_mismatch for non-plaid provider", async () => {
    const pool = makePool([]);
    const resolver = createPlaidTenantResolver(pool as never);

    await expect(resolver("stripe", Buffer.alloc(0), headers)).rejects.toMatchObject({
      code: "auth_tenant_mismatch",
    });
  });
});
