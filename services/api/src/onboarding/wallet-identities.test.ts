import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { linkWallet, PostgresWalletIdentityReader } from "./wallet-identities.js";

interface Captured {
  sql: string;
  values: unknown[];
}

function makeScopedPool(opts: { failOn?: RegExp; failCode?: string } = {}): {
  pool: Pool;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const client = {
    query: vi.fn((sql: string, values?: unknown[]) => {
      calls.push({ sql, values: values ?? [] });
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (opts.failOn !== undefined && opts.failOn.test(sql)) {
        const err = new Error("dup") as Error & { code?: string };
        err.code = opts.failCode ?? "23505";
        return Promise.reject(err);
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool, calls };
}

/** A bare pool whose `query` returns fixed rows (for the privileged reader). */
function makeQueryPool(rows: unknown[]): { pool: Pool; calls: Captured[] } {
  const calls: Captured[] = [];
  const pool = {
    query: vi.fn((sql: string, values?: unknown[]) => {
      calls.push({ sql, values: values ?? [] });
      return Promise.resolve({ rows, rowCount: rows.length });
    }),
  } as unknown as Pool;
  return { pool, calls };
}

const TENANT = "tnt_01J0000000000000000000000Z";
const ADDR = "0xAbCdEf0000000000000000000000000000000001";

describe("linkWallet — RFC 0002 Phase D", () => {
  it("inserts a lowercased address scoped to the caller's tenant", async () => {
    const { pool, calls } = makeScopedPool();
    await linkWallet(pool, {
      tenantId: TENANT,
      address: ADDR,
      principalType: "human",
      principalId: "user_01J0000000000000000000000A",
    });
    const setConfig = calls.find((c) => c.sql.startsWith("SELECT set_config"));
    expect(setConfig?.values[0]).toBe(TENANT);
    const insert = calls.find((c) => /INSERT INTO wallet_identities/.test(c.sql));
    expect(insert?.values[0]).toBe(ADDR.toLowerCase()); // lowercased
    expect(insert?.values[1]).toBe(TENANT);
    expect(insert?.values[2]).toBe("human");
    expect(calls.some((c) => c.sql === "COMMIT")).toBe(true);
  });

  it("maps a duplicate address to wallet_already_linked (and rolls back)", async () => {
    const { pool, calls } = makeScopedPool({ failOn: /INSERT INTO wallet_identities/ });
    await expect(
      linkWallet(pool, {
        tenantId: TENANT,
        address: ADDR,
        principalType: "agent",
        principalId: "agent_01J0000000000000000000000B",
      }),
    ).rejects.toMatchObject({ code: "wallet_already_linked" });
    expect(calls.some((c) => c.sql === "ROLLBACK")).toBe(true);
  });

  it("rethrows a non-unique DB error", async () => {
    const { pool } = makeScopedPool({ failOn: /INSERT/, failCode: "08006" });
    await expect(
      linkWallet(pool, {
        tenantId: TENANT,
        address: ADDR,
        principalType: "human",
        principalId: "user_x",
      }),
    ).rejects.toMatchObject({ code: "08006" });
  });
});

describe("PostgresWalletIdentityReader — RFC 0002 Phase D", () => {
  it("resolves a linked wallet (case-insensitive) to its tenant + principal", async () => {
    const { pool, calls } = makeQueryPool([
      { tenant_id: TENANT, principal_type: "human", principal_id: "user_owner" },
    ]);
    const res = await new PostgresWalletIdentityReader(pool).resolveByAddress(ADDR.toUpperCase());
    expect(res).toEqual({
      tenantId: TENANT,
      principalType: "human",
      principalId: "user_owner",
    });
    // The query lowercases via SQL LOWER($1); the raw arg is passed through.
    expect(calls[0]?.values[0]).toBe(ADDR.toUpperCase());
  });

  it("returns null for an unlinked wallet", async () => {
    const { pool } = makeQueryPool([]);
    const res = await new PostgresWalletIdentityReader(pool).resolveByAddress(ADDR);
    expect(res).toBeNull();
  });
});
