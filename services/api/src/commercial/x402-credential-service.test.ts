import { describe, expect, it } from "vitest";
import {
  validateOperations,
  X402_KEY_MAX_ROTATION_OVERLAP_HOURS,
  X402_KEY_PREFIX,
} from "./x402-credential-service.js";

describe("x402 pay-per-call credentials", () => {
  it("pins distinct test and live prefixes and the 24-hour overlap ceiling", () => {
    expect(X402_KEY_PREFIX).toEqual({
      sandbox: "brain_xk_test_",
      live: "brain_xk_live_",
    });
    expect(X402_KEY_MAX_ROTATION_OVERLAP_HOURS).toBe(24);
  });

  it("accepts only a nonempty subset of the fixed six-operation allowlist", () => {
    expect(validateOperations(["listAccounts", "ledger.accounts.list"])).toEqual([
      "listAccounts",
      "ledger.accounts.list",
    ]);
    expect(() => validateOperations([])).toThrow(/nonempty subset/);
    expect(() => validateOperations(["paymentIntentApprove"])).toThrow(/nonempty subset/);
  });
});
