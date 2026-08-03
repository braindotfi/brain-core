import { describe, expect, it } from "vitest";
import { assertAuthDbReachable, resolveRoleUrl } from "../src/db.js";
import type { AuthDbPools } from "../src/db.js";
import type { Pool } from "pg";

describe("resolveRoleUrl", () => {
  it("returns the configured URL when present", () => {
    expect(
      resolveRoleUrl("BRAIN_AUTH_DB_URL", "postgres://brain_auth@host/db", {
        nodeEnv: "production",
        databaseUrl: "postgres://brain@host/db",
      }),
    ).toBe("postgres://brain_auth@host/db");
  });

  it("throws in production when the role URL is missing", () => {
    expect(() =>
      resolveRoleUrl("BRAIN_AUTH_DB_URL", undefined, {
        nodeEnv: "production",
        databaseUrl: "postgres://brain@host/db",
      }),
    ).toThrow(/BRAIN_AUTH_DB_URL is required in NODE_ENV=production/);
  });

  it("falls back to DATABASE_URL with a warning outside production", () => {
    const warnings: string[] = [];
    const url = resolveRoleUrl("BRAIN_RESOLVER_DB_URL", undefined, {
      nodeEnv: "development",
      databaseUrl: "postgres://brain@host/db",
      warn: (m) => warnings.push(m),
    });
    expect(url).toBe("postgres://brain@host/db");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("BRAIN_RESOLVER_DB_URL");
  });

  it("treats an empty string the same as unset", () => {
    expect(() =>
      resolveRoleUrl("BRAIN_AUTH_AUDIT_DB_URL", "", {
        nodeEnv: "production",
        databaseUrl: "postgres://brain@host/db",
      }),
    ).toThrow();
  });
});

describe("assertAuthDbReachable", () => {
  /** Only `query` is exercised; the rest of pg.Pool is irrelevant to this probe. */
  function poolsWhere(failing: ReadonlySet<string>): AuthDbPools {
    const make = (label: string): Pool =>
      ({
        query: async () => {
          if (failing.has(label)) throw new Error("The server does not support SSL connections");
          return { rows: [{ "?column?": 1 }] };
        },
      }) as unknown as Pool;
    return {
      authPool: make("auth"),
      resolverPool: make("resolver"),
      auditPool: make("audit"),
    };
  }

  it("resolves when every pool answers", async () => {
    await expect(
      assertAuthDbReachable(poolsWhere(new Set()), "production"),
    ).resolves.toBeUndefined();
  });

  it("names the offending role URL when a pool cannot connect in production", async () => {
    await expect(
      assertAuthDbReachable(poolsWhere(new Set(["auth"])), "production"),
    ).rejects.toThrow(/BRAIN_AUTH_DB_URL is configured but not reachable/);
  });

  it("reports the resolver and audit pools by their own env var names", async () => {
    await expect(
      assertAuthDbReachable(poolsWhere(new Set(["resolver"])), "production"),
    ).rejects.toThrow(/BRAIN_RESOLVER_DB_URL/);
    await expect(
      assertAuthDbReachable(poolsWhere(new Set(["audit"])), "production"),
    ).rejects.toThrow(/BRAIN_AUTH_AUDIT_DB_URL/);
  });

  it("surfaces the underlying driver message, so the TLS case is diagnosable", async () => {
    await expect(
      assertAuthDbReachable(poolsWhere(new Set(["auth"])), "production"),
    ).rejects.toThrow(/does not support SSL connections/);
  });

  it("stays out of the way outside production, where the DB may not be up", async () => {
    await expect(
      assertAuthDbReachable(poolsWhere(new Set(["auth", "resolver", "audit"])), "development"),
    ).resolves.toBeUndefined();
  });
});
