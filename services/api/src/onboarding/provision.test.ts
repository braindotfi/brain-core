import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { isBrainId, ID_PREFIX } from "@brain/shared";
import { provisionTenant } from "./provision.js";

interface Captured {
  sql: string;
  values: unknown[];
}

/**
 * Fake pool that records every statement (incl. BEGIN / set_config / COMMIT /
 * ROLLBACK) so the test can assert the transaction shape AND the tenant-scope.
 * `failOn` lets a test simulate a unique-violation on a chosen INSERT.
 */
function makeFakePool(opts: { failOn?: RegExp; failCode?: string } = {}): {
  pool: Pool;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const client = {
    query: vi.fn((sql: string, values?: unknown[]) => {
      calls.push({ sql, values: values ?? [] });
      if (opts.failOn !== undefined && opts.failOn.test(sql)) {
        const err = new Error("duplicate key value violates unique constraint") as Error & {
          code?: string;
        };
        err.code = opts.failCode ?? "23505";
        return Promise.reject(err);
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool;
  return { pool, calls };
}

const INPUT = {
  email: "founder@example.com",
  passwordHash: "scrypt$32768$8$1$c2FsdA$ZGs",
  emailVerificationTokenHash: "a".repeat(64),
  emailVerificationExpiresAt: new Date("2026-06-01T00:00:00Z"),
};

describe("provisionTenant — RFC 0002 Phase B", () => {
  it("mints fresh tnt_/user_ ids and inserts tenant + owner + verification atomically", async () => {
    const { pool, calls } = makeFakePool();
    const { tenantId, userId } = await provisionTenant(pool, INPUT);

    expect(isBrainId(tenantId, ID_PREFIX.tenant)).toBe(true);
    expect(isBrainId(userId, ID_PREFIX.user)).toBe(true);

    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toBe("SELECT set_config('app.tenant_id', $1, true)");
    expect(sqls.at(-1)).toBe("COMMIT");
    // The three domain inserts, in order.
    expect(sqls.some((s) => /INSERT INTO tenants/.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO users/.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO email_verifications/.test(s))).toBe(true);
  });

  it("scopes the whole transaction to the freshly-minted tenant id (isolation)", async () => {
    const { pool, calls } = makeFakePool();
    const { tenantId, userId } = await provisionTenant(pool, INPUT);

    // RLS scope is set to the new tenant id — never a caller-supplied value.
    const setConfig = calls.find((c) => c.sql.startsWith("SELECT set_config"));
    expect(setConfig?.values[0]).toBe(tenantId);

    // EVERY domain insert carries that same tenant id — the writer cannot touch
    // any other tenant's rows.
    for (const c of calls) {
      if (/INSERT INTO tenants/.test(c.sql)) expect(c.values[0]).toBe(tenantId);
      if (/INSERT INTO users/.test(c.sql)) {
        expect(c.values[0]).toBe(userId);
        expect(c.values[1]).toBe(tenantId);
      }
      if (/INSERT INTO email_verifications/.test(c.sql)) {
        expect(c.values[1]).toBe(userId);
        expect(c.values[2]).toBe(tenantId);
      }
    }
  });

  it("persists the password hash and verification token (never the plaintext)", async () => {
    const { pool, calls } = makeFakePool();
    await provisionTenant(pool, INPUT);
    const userInsert = calls.find((c) => /INSERT INTO users/.test(c.sql));
    expect(userInsert?.values).toContain(INPUT.passwordHash);
    expect(userInsert?.values).toContain(INPUT.email);
    const verifyInsert = calls.find((c) => /INSERT INTO email_verifications/.test(c.sql));
    expect(verifyInsert?.values[0]).toBe(INPUT.emailVerificationTokenHash);
    expect(verifyInsert?.values[3]).toBe(INPUT.emailVerificationExpiresAt);
  });

  it("maps a unique-violation on the email to signup_email_taken (and rolls back)", async () => {
    const { pool, calls } = makeFakePool({ failOn: /INSERT INTO users/, failCode: "23505" });
    await expect(provisionTenant(pool, INPUT)).rejects.toMatchObject({
      code: "signup_email_taken",
    });
    expect(calls.some((c) => c.sql === "ROLLBACK")).toBe(true);
    expect(calls.some((c) => c.sql === "COMMIT")).toBe(false);
  });

  it("rethrows a non-unique DB error unchanged (after rollback)", async () => {
    const { pool, calls } = makeFakePool({ failOn: /INSERT INTO tenants/, failCode: "08006" });
    await expect(provisionTenant(pool, INPUT)).rejects.toMatchObject({ code: "08006" });
    expect(calls.some((c) => c.sql === "ROLLBACK")).toBe(true);
  });
});
