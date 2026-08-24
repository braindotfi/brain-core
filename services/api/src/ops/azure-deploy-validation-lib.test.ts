import { describe, expect, it } from "vitest";
import {
  assertMountedSecrets,
  assertServiceHealth,
  parseRoleEnvMap,
  requiredEnv,
  safeFailureCode,
} from "./azure-deploy-validation-lib.js";

describe("Azure deploy validation helpers", () => {
  it("requires the exact service and immutable commit", () => {
    expect(() =>
      assertServiceHealth(
        { ok: true, service: "brain-api", commit: "a".repeat(40) },
        "brain-api",
        "a".repeat(40),
      ),
    ).not.toThrow();
    expect(() =>
      assertServiceHealth(
        { ok: true, service: "brain-api", commit: "dev" },
        "brain-api",
        "a".repeat(40),
      ),
    ).toThrow("health_wrong_commit");
  });

  it("fails closed for missing and placeholder mounted secrets", () => {
    expect(assertMountedSecrets("ONE,TWO,ONE", { ONE: "set", TWO: "also-set" })).toBe(2);
    expect(() => assertMountedSecrets("ONE,TWO", { ONE: "set" })).toThrow("missing_env:TWO");
    expect(() => assertMountedSecrets("ONE", { ONE: "PLACEHOLDER-SET-OUT-OF-BAND" })).toThrow(
      "placeholder_secret:ONE",
    );
  });

  it("parses the Terraform role-to-environment contract", () => {
    expect(parseRoleEnvMap('{"brain_app":"DATABASE_URL"}')).toEqual({
      brain_app: "DATABASE_URL",
    });
    expect(() => parseRoleEnvMap("[]")).toThrow("db_role_map_not_object");
  });

  it("does not echo arbitrary provider errors", () => {
    expect(requiredEnv("SAFE", { SAFE: "value" })).toBe("value");
    expect(safeFailureCode(new Error("getaddrinfo_enotfound"))).toBe("getaddrinfo_enotfound");
    expect(safeFailureCode(new Error("failed postgres://user:password@host"))).toBe(
      "validation_failed",
    );
  });
});
