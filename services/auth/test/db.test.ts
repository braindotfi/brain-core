import { describe, expect, it } from "vitest";
import { resolveRoleUrl } from "../src/db.js";

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
