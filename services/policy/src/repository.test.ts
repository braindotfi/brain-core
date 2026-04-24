import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isValidTransition, type PolicyState } from "./repository.js";

const STATES: PolicyState[] = [
  "draft",
  "pending_signatures",
  "active",
  "deactivated",
  "cancelled",
  "expired",
];

describe("§8.3 policy state machine", () => {
  it("draft → pending_signatures | cancelled", () => {
    expect(isValidTransition("draft", "pending_signatures")).toBe(true);
    expect(isValidTransition("draft", "cancelled")).toBe(true);
    expect(isValidTransition("draft", "active")).toBe(false);
  });

  it("pending_signatures → active | expired", () => {
    expect(isValidTransition("pending_signatures", "active")).toBe(true);
    expect(isValidTransition("pending_signatures", "expired")).toBe(true);
    expect(isValidTransition("pending_signatures", "cancelled")).toBe(false);
  });

  it("active → deactivated only", () => {
    expect(isValidTransition("active", "deactivated")).toBe(true);
    expect(isValidTransition("active", "pending_signatures")).toBe(false);
  });

  it("terminal states have no outgoing transitions", () => {
    for (const from of ["deactivated", "cancelled", "expired"] as const) {
      for (const to of STATES) {
        expect(isValidTransition(from, to)).toBe(false);
      }
    }
  });

  it("property: no self-transitions", () => {
    fc.assert(
      fc.property(fc.constantFrom(...STATES), (s) => {
        expect(isValidTransition(s, s)).toBe(false);
      }),
    );
  });
});
