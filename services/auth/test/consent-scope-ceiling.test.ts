/**
 * The AS's consentable-scope ceiling, proved by execution rather than
 * asserted in prose -- mirrors services/mcp/src/tools/registry.no-execute.test.ts's
 * "prove it, do not assert it in prose" posture (OAUTH-AS-PLAN.md section 0).
 *
 * `computeConsentableScopes` (src/consent.ts) intersects unconditionally
 * against `AGENT_PERMITTED_SCOPES`, so that constant IS the ceiling: nothing
 * this module returns can ever exceed it. This test fuzzes every VALID_SCOPES
 * member as both "requested" and "registered" and asserts the intersection
 * never contains a forbidden scope, so a future edit that (accidentally or
 * not) widens the intersection logic still fails here.
 */

import { describe, expect, it } from "vitest";
import { AGENT_PERMITTED_SCOPES, VALID_SCOPES, type Scope } from "@brain/shared";
import { computeConsentableScopes } from "../src/consent.js";

const ALL_SCOPES = [...VALID_SCOPES] as Scope[];

const FORBIDDEN = [
  "payment_intent:approve",
  "payment_intent:execute",
  "policy:sign",
] as const satisfies readonly Scope[];

describe("consentable-scope ceiling", () => {
  it("AGENT_PERMITTED_SCOPES contains none of the forbidden scopes", () => {
    for (const scope of FORBIDDEN) {
      expect(AGENT_PERMITTED_SCOPES.has(scope)).toBe(false);
    }
  });

  it("AGENT_PERMITTED_SCOPES contains no *:admin scope for any layer", () => {
    const adminScopes = [...AGENT_PERMITTED_SCOPES].filter((s) => s.endsWith(":admin"));
    expect(adminScopes).toEqual([]);
  });

  it("computeConsentableScopes never returns a forbidden scope, even given every valid scope as both requested and registered", () => {
    const result = computeConsentableScopes(ALL_SCOPES, ALL_SCOPES);
    for (const scope of FORBIDDEN) {
      expect(result).not.toContain(scope);
    }
    expect(result.some((s) => s.endsWith(":admin"))).toBe(false);
  });

  it("computeConsentableScopes given every valid scope is always a subset of AGENT_PERMITTED_SCOPES", () => {
    const result = computeConsentableScopes(ALL_SCOPES, ALL_SCOPES);
    expect(result.every((s) => AGENT_PERMITTED_SCOPES.has(s))).toBe(true);
  });
});
