import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  assertPaymentIntentTransition,
  isValidPaymentIntentTransition,
  type PaymentIntentState,
} from "./state-machine.js";

const ALL: PaymentIntentState[] = [
  "proposed",
  "pending_approval",
  "approved",
  "rejected",
  "executed",
  "failed",
  "cancelled",
];

describe("§9.5 PaymentIntent state machine", () => {
  it("proposed → pending_approval | approved | rejected | cancelled", () => {
    expect(isValidPaymentIntentTransition("proposed", "pending_approval")).toBe(true);
    expect(isValidPaymentIntentTransition("proposed", "approved")).toBe(true);
    expect(isValidPaymentIntentTransition("proposed", "rejected")).toBe(true);
    expect(isValidPaymentIntentTransition("proposed", "cancelled")).toBe(true);
    expect(isValidPaymentIntentTransition("proposed", "executed")).toBe(false);
    expect(isValidPaymentIntentTransition("proposed", "failed")).toBe(false);
  });

  it("pending_approval → approved | rejected only", () => {
    expect(isValidPaymentIntentTransition("pending_approval", "approved")).toBe(true);
    expect(isValidPaymentIntentTransition("pending_approval", "rejected")).toBe(true);
    expect(isValidPaymentIntentTransition("pending_approval", "executed")).toBe(false);
    expect(isValidPaymentIntentTransition("pending_approval", "cancelled")).toBe(false);
  });

  it("approved → executed | rejected | failed", () => {
    expect(isValidPaymentIntentTransition("approved", "executed")).toBe(true);
    expect(isValidPaymentIntentTransition("approved", "rejected")).toBe(true);
    expect(isValidPaymentIntentTransition("approved", "failed")).toBe(true);
    expect(isValidPaymentIntentTransition("approved", "cancelled")).toBe(false);
  });

  it("executed → failed only (rail reversal)", () => {
    expect(isValidPaymentIntentTransition("executed", "failed")).toBe(true);
    expect(isValidPaymentIntentTransition("executed", "approved")).toBe(false);
    expect(isValidPaymentIntentTransition("executed", "executed")).toBe(false);
  });

  it("rejected / cancelled / failed are terminal sinks", () => {
    for (const from of ["rejected", "cancelled", "failed"] as const) {
      for (const to of ALL) {
        expect(isValidPaymentIntentTransition(from, to)).toBe(false);
      }
    }
  });

  it("property: no self-transitions", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL), (s) => {
        expect(isValidPaymentIntentTransition(s, s)).toBe(false);
      }),
    );
  });

  it("property: every reachable terminal cannot leave", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("rejected" as const, "cancelled" as const, "failed" as const),
        fc.constantFrom(...ALL),
        (from, to) => {
          expect(isValidPaymentIntentTransition(from, to)).toBe(false);
        },
      ),
    );
  });

  it("assertPaymentIntentTransition does not throw on valid transition", () => {
    expect(() => assertPaymentIntentTransition("proposed", "approved")).not.toThrow();
  });

  it("assertPaymentIntentTransition throws on invalid transition", () => {
    expect(() => assertPaymentIntentTransition("rejected", "approved")).toThrow();
  });
});
