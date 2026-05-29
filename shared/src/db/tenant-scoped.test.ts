import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { isBrainError } from "../errors.js";
import { newTenantId, newUserId } from "../ids.js";
import { withServiceScope, withTenantScope } from "./tenant-scoped.js";

/**
 * Build a minimal pg.Pool double that records the SQL statements issued
 * through the checked-out client. Validates the BEGIN / set_config / COMMIT
 * ordering without spinning up a real Postgres.
 */
function makeFakePool(): {
  pool: { connect: () => Promise<unknown> };
  log: string[];
  client: {
    released: boolean;
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
} {
  const log: string[] = [];
  const client = {
    released: false,
    query: vi.fn(async (text: string, _values?: unknown[]) => {
      log.push(text);
      return { rows: [{ tid: "tnt_TEST" }], rowCount: 1 };
    }),
    release: vi.fn(() => {
      client.released = true;
    }),
  };
  return {
    pool: { connect: async () => client },
    log,
    client,
  };
}

describe("withTenantScope", () => {
  it("wraps fn in BEGIN / SET / COMMIT and releases the client", async () => {
    const { pool, log, client } = makeFakePool();
    const tenantId = newTenantId();

    const result = await withTenantScope(pool as unknown as Pool, tenantId, async (c) => {
      await c.query("SELECT 1");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(log[0]).toBe("BEGIN");
    expect(log[1]).toBe("SELECT set_config('app.tenant_id', $1, true)");
    expect(log[2]).toBe("SELECT 1");
    expect(log[3]).toBe("COMMIT");
    expect(client.released).toBe(true);
  });

  it("rolls back on throw and re-raises the original error", async () => {
    const { pool, log, client } = makeFakePool();
    const tenantId = newTenantId();
    const boom = new Error("boom");

    await expect(
      withTenantScope(pool as unknown as Pool, tenantId, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(log).toContain("ROLLBACK");
    expect(log).not.toContain("COMMIT");
    expect(client.released).toBe(true);
  });

  it("rejects malformed tenant ids with auth_tenant_mismatch", async () => {
    const { pool } = makeFakePool();
    try {
      await withTenantScope(pool as unknown as Pool, "not-a-tenant", async () => "x");
      expect.fail("expected throw");
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
      if (isBrainError(err)) {
        expect(err.code).toBe("auth_tenant_mismatch");
      }
    }
  });

  it("does not call connect when the tenant id is invalid", async () => {
    const pool = { connect: vi.fn() };
    await withTenantScope(pool as unknown as Pool, "bogus", async () => "x").catch(() => undefined);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("swallows ROLLBACK failures and surfaces the original error", async () => {
    const log: string[] = [];
    const rollbackFailure = new Error("rollback blew up");
    const client = {
      released: false,
      query: vi.fn(async (text: string) => {
        log.push(text);
        if (text === "ROLLBACK") throw rollbackFailure;
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(() => {
        client.released = true;
      }),
    };
    const pool = { connect: async () => client };
    const tenantId = newTenantId();
    const boom = new Error("user code failure");

    await expect(
      withTenantScope(pool as unknown as Pool, tenantId, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(log).toContain("ROLLBACK");
    expect(client.released).toBe(true);
  });
});

describe("withServiceScope — sets app.tenant_id AND app.actor", () => {
  it("issues set_config for both app.tenant_id and app.actor in the txn", async () => {
    const { pool, log, client } = makeFakePool();
    const tenantId = newTenantId();
    const actorId = newUserId();
    await withServiceScope(pool as unknown as Pool, { tenantId, actor: actorId }, async () => {
      /* no-op */
    });
    expect(log[0]).toBe("BEGIN");
    expect(log[1]).toContain("set_config('app.tenant_id'");
    expect(log[2]).toContain("set_config('app.actor'");
    expect(log).toContain("COMMIT");
    // Both values were passed positionally; spy on the query mock to confirm.
    const calls = vi.mocked(client.query).mock.calls as Array<[string, unknown[]?]>;
    const tenantCall = calls.find((c) => c[0].includes("app.tenant_id"));
    const actorCall = calls.find((c) => c[0].includes("app.actor"));
    expect((tenantCall?.[1] ?? [])[0]).toBe(tenantId);
    expect((actorCall?.[1] ?? [])[0]).toBe(actorId);
  });

  it("rejects an invalid tenant id (shared validation with withTenantScope)", async () => {
    const { pool } = makeFakePool();
    try {
      await withServiceScope(
        pool as unknown as Pool,
        { tenantId: "not_a_tenant", actor: newUserId() },
        async () => {
          /* unreachable */
        },
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(isBrainError(err) && err.code).toBe("auth_tenant_mismatch");
    }
  });

  it("rolls back when the body throws", async () => {
    const { pool, log, client } = makeFakePool();
    const boom = new Error("inner failure");
    await expect(
      withServiceScope(
        pool as unknown as Pool,
        { tenantId: newTenantId(), actor: newUserId() },
        async () => {
          throw boom;
        },
      ),
    ).rejects.toBe(boom);
    expect(log).toContain("ROLLBACK");
    expect(client.released).toBe(true);
  });
});
