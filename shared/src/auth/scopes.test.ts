import { describe, expect, it } from "vitest";
import { isBrainError } from "../errors.js";
import {
  AGENT_PERMITTED_SCOPES,
  VALID_SCOPES,
  hasScope,
  isValidScope,
  requireScope,
} from "./scopes.js";

describe("VALID_SCOPES", () => {
  it("includes the well-known {layer}:{verb} pairs", () => {
    for (const s of [
      "raw:read",
      "raw:write",
      "wiki:read",
      "policy:sign",
      "execution:propose",
      "audit:read",
      "audit:admin",
    ] as const) {
      expect(VALID_SCOPES.has(s)).toBe(true);
    }
  });
});

describe("isValidScope", () => {
  it("accepts valid scopes", () => {
    expect(isValidScope("raw:write")).toBe(true);
  });
  it("rejects unknown layers or verbs", () => {
    expect(isValidScope("widgets:write")).toBe(false);
    expect(isValidScope("raw:delete")).toBe(false);
    expect(isValidScope("rawwrite")).toBe(false);
  });
});

describe("AGENT_PERMITTED_SCOPES", () => {
  it("is the functional five-scope set an external agent may hold (§3.2)", () => {
    // §3.2 lists five: ledger:read, wiki:read, raw:write, payment_intent:propose,
    // and the non-financial-proposal scope the doc calls agent:propose — which the
    // codebase implements under the legacy name execution:propose (the MCP
    // agent.action.propose tool and SIWX grant both use execution:propose).
    expect(AGENT_PERMITTED_SCOPES.size).toBe(5);
    for (const s of [
      "ledger:read",
      "wiki:read",
      "raw:write",
      "payment_intent:propose",
      "execution:propose",
    ] as const) {
      expect(AGENT_PERMITTED_SCOPES.has(s)).toBe(true);
    }
    // Admin/sign scopes are never agent-holdable.
    expect(AGENT_PERMITTED_SCOPES.has("policy:sign")).toBe(false);
    expect(AGENT_PERMITTED_SCOPES.has("audit:read")).toBe(false);
  });
});

describe("hasScope", () => {
  it("returns true when the exact scope is held", () => {
    expect(hasScope(["raw:write", "wiki:read"], "raw:write")).toBe(true);
  });
  it("returns false when the scope is absent", () => {
    expect(hasScope(["raw:read"], "raw:write")).toBe(false);
  });
  it("treats layer admin as implying every verb in that layer", () => {
    expect(hasScope(["raw:admin"], "raw:write")).toBe(true);
    expect(hasScope(["raw:admin"], "raw:read")).toBe(true);
    // But does NOT span layers.
    expect(hasScope(["raw:admin"], "wiki:read")).toBe(false);
  });
});

describe("requireScope", () => {
  it("returns silently when satisfied", () => {
    expect(() => requireScope(["raw:write"], "raw:write")).not.toThrow();
    expect(() => requireScope(["raw:admin"], "raw:write")).not.toThrow();
  });
  it("throws auth_scope_insufficient with details when not satisfied", () => {
    try {
      requireScope(["wiki:read"], "raw:write");
      expect.fail("expected throw");
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
      if (isBrainError(err)) {
        expect(err.code).toBe("auth_scope_insufficient");
        expect(err.details).toMatchObject({
          required: "raw:write",
          held: ["wiki:read"],
        });
      }
    }
  });
});
