import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createProviderTenantResolver, createStripeTenantResolver } from "./stripeTenant.js";

function fakePool(rows: Array<{ tenant_id: string }>): { pool: Pool; queries: unknown[][] } {
  const queries: unknown[][] = [];
  const pool = {
    query: vi.fn(async (_text: string, values?: unknown[]) => {
      queries.push(values ?? []);
      return { rows, rowCount: rows.length };
    }),
  } as unknown as Pool;
  return { pool, queries };
}

const HEADERS = {};

describe("createStripeTenantResolver", () => {
  it("maps event.account to the owning tenant via the sync-partition checkpoint", async () => {
    const { pool, queries } = fakePool([{ tenant_id: "tnt_42" }]);
    const resolve = createStripeTenantResolver(pool);
    const body = Buffer.from(JSON.stringify({ id: "evt_1", account: "acct_S1" }));
    await expect(resolve("stripe", body, HEADERS)).resolves.toBe("tnt_42");
    expect(queries[0]).toEqual(["acct_S1"]);
  });

  it("rejects direct-account events with no account id (pull path covers them)", async () => {
    const { pool } = fakePool([]);
    const resolve = createStripeTenantResolver(pool);
    const body = Buffer.from(JSON.stringify({ id: "evt_1" }));
    await expect(resolve("stripe", body, HEADERS)).rejects.toMatchObject({
      code: "auth_tenant_mismatch",
    });
  });

  it("rejects an account no tenant has connected", async () => {
    const { pool } = fakePool([]);
    const resolve = createStripeTenantResolver(pool);
    const body = Buffer.from(JSON.stringify({ account: "acct_ghost" }));
    await expect(resolve("stripe", body, HEADERS)).rejects.toMatchObject({
      code: "auth_tenant_mismatch",
    });
  });

  it("rejects non-JSON bodies", async () => {
    const { pool } = fakePool([]);
    const resolve = createStripeTenantResolver(pool);
    await expect(resolve("stripe", Buffer.from("nope"), HEADERS)).rejects.toMatchObject({
      code: "request_body_invalid",
    });
  });
});

describe("createProviderTenantResolver", () => {
  it("routes by provider and rejects unknown providers", async () => {
    const resolve = createProviderTenantResolver({
      stripe: async () => "tnt_stripe",
      plaid: async () => "tnt_plaid",
    });
    await expect(resolve("stripe", Buffer.alloc(0), HEADERS)).resolves.toBe("tnt_stripe");
    await expect(resolve("plaid", Buffer.alloc(0), HEADERS)).resolves.toBe("tnt_plaid");
    await expect(resolve("netsuite", Buffer.alloc(0), HEADERS)).rejects.toMatchObject({
      code: "auth_tenant_mismatch",
    });
  });
});
