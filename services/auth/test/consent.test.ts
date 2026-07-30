import { describe, expect, it } from "vitest";
import type { Scope } from "@brain/shared";
import { computeConsentableScopes, narrowByDeselection, parseScopeParam } from "../src/consent.js";

describe("parseScopeParam", () => {
  it("splits a space-delimited scope string", () => {
    expect(parseScopeParam("ledger:read wiki:read")).toEqual(["ledger:read", "wiki:read"]);
  });

  it("drops unknown scope tokens", () => {
    expect(parseScopeParam("ledger:read bogus:verb")).toEqual(["ledger:read"]);
  });

  it("returns empty for undefined or blank input", () => {
    expect(parseScopeParam(undefined)).toEqual([]);
    expect(parseScopeParam("   ")).toEqual([]);
  });

  it("tolerates repeated whitespace", () => {
    expect(parseScopeParam("ledger:read   wiki:read")).toEqual(["ledger:read", "wiki:read"]);
  });
});

describe("computeConsentableScopes (the intersection, OAUTH-AS-PLAN.md section 0)", () => {
  it("a requested superset narrows to the registered set", () => {
    const requested: Scope[] = ["ledger:read", "wiki:read", "raw:write"];
    const registered: Scope[] = ["ledger:read", "wiki:read"];
    expect(computeConsentableScopes(requested, registered)).toEqual(["ledger:read", "wiki:read"]);
  });

  it("a requested scope outside AGENT_PERMITTED_SCOPES is dropped even if registered", () => {
    // payment_intent:approve is registered for the "partner" role but is not
    // in AGENT_PERMITTED_SCOPES -- the AS ceiling must drop it regardless.
    const requested: Scope[] = ["payment_intent:approve", "ledger:read"];
    const registered: Scope[] = ["payment_intent:approve", "ledger:read"];
    expect(computeConsentableScopes(requested, registered)).toEqual(["ledger:read"]);
  });

  it("a registered scope not requested is never offered", () => {
    const requested: Scope[] = ["ledger:read"];
    const registered: Scope[] = ["ledger:read", "wiki:read"];
    expect(computeConsentableScopes(requested, registered)).toEqual(["ledger:read"]);
  });

  it("no overlap yields an empty consentable set", () => {
    const requested: Scope[] = ["raw:write"];
    const registered: Scope[] = ["ledger:read"];
    expect(computeConsentableScopes(requested, registered)).toEqual([]);
  });
});

describe("narrowByDeselection (section 0 step 4: deselect, never add)", () => {
  it("a deselection narrows the granted set", () => {
    const consentable: Scope[] = ["ledger:read", "wiki:read"];
    expect(narrowByDeselection(consentable, ["ledger:read"])).toEqual(["ledger:read"]);
  });

  it("nothing can widen the granted set beyond what was offered", () => {
    const consentable: Scope[] = ["ledger:read"];
    // A tampered submission naming a scope never offered must not appear.
    expect(narrowByDeselection(consentable, ["ledger:read", "payment_intent:execute"])).toEqual([
      "ledger:read",
    ]);
  });

  it("an empty selection grants nothing", () => {
    const consentable: Scope[] = ["ledger:read", "wiki:read"];
    expect(narrowByDeselection(consentable, [])).toEqual([]);
  });
});
