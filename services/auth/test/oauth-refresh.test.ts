/**
 * Unit tests for the refresh-grant scope narrowing decision (Phase 2b). The
 * pure function under test, `narrowRefreshScopes`, lives in src/consent.ts
 * (not src/oauth-refresh.ts) -- it belongs with the rest of the scope-model
 * logic (parseScopeParam, computeConsentableScopes, narrowByDeselection),
 * kept in this file per OAUTH-AS-PLAN.md's Phase 2b test-plan naming. No DB
 * needed: everything DB-backed (rotation, reuse, revocation, grant/agent
 * checks) is covered by the integration suite instead.
 */

import { describe, expect, it } from "vitest";
import type { Scope } from "@brain/shared";
import { narrowRefreshScopes } from "../src/consent.js";

describe("narrowRefreshScopes (RFC 6749 section 6: narrow only, never widen)", () => {
  it("no scope param carries the stored scopes forward unchanged", () => {
    const stored: Scope[] = ["ledger:read", "wiki:read"];
    expect(narrowRefreshScopes(stored, undefined)).toEqual({
      ok: true,
      scopes: ["ledger:read", "wiki:read"],
    });
  });

  it("a requested subset of the stored scopes is accepted", () => {
    const stored: Scope[] = ["ledger:read", "wiki:read"];
    expect(narrowRefreshScopes(stored, "ledger:read")).toEqual({
      ok: true,
      scopes: ["ledger:read"],
    });
  });

  it("a requested scope outside the stored set is rejected outright, not silently dropped", () => {
    const stored: Scope[] = ["ledger:read"];
    expect(narrowRefreshScopes(stored, "ledger:read wiki:read")).toEqual({ ok: false });
  });

  it("the AGENT_PERMITTED_SCOPES ceiling holds even for a stored row containing a forbidden scope", () => {
    // payment_intent:approve is a VALID_SCOPES member but not in
    // AGENT_PERMITTED_SCOPES -- a stale/corrupted stored row must not let it
    // through on refresh regardless of the scope param.
    const stored: Scope[] = ["ledger:read", "payment_intent:approve"];
    expect(narrowRefreshScopes(stored, undefined)).toEqual({ ok: true, scopes: ["ledger:read"] });
    expect(narrowRefreshScopes(stored, "payment_intent:approve")).toEqual({
      ok: true,
      scopes: [],
    });
  });

  it("an empty stored set with no scope param yields an empty grant, not an error", () => {
    expect(narrowRefreshScopes([], undefined)).toEqual({ ok: true, scopes: [] });
  });
});
