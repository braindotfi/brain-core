/**
 * Tests for the Coinbase Spend Permission model (RFC 0001 §7.5, Phase 4-A).
 *
 * The point: an external 4337 / Coinbase Smart Wallet authorization is validated
 * deterministically — token (USDC), spender, amount ≤ allowance, time window —
 * and projects onto the §6 micropayment window cap + the BrainSmartAccount
 * session-key shape, so the open path routes through the SAME gate.
 */

import { describe, expect, it } from "vitest";
import {
  validateSpendPermission,
  toMicropaymentWindowCap,
  toSessionKeyShape,
  type SpendPermission,
  type SpendRequest,
} from "./spend-permission.js";

const USDC = "0x" + "ab".repeat(20);
const SPENDER = "0x" + "cd".repeat(20);
const ACCOUNT = "0x" + "ef".repeat(20);
const SALT = "0x" + "12".repeat(32);

function permission(overrides: Partial<SpendPermission> = {}): SpendPermission {
  return {
    account: ACCOUNT,
    spender: SPENDER,
    token: USDC,
    allowance: "100.00",
    period: 86_400,
    start: 1_000,
    end: 2_000_000,
    salt: SALT,
    ...overrides,
  };
}

function request(overrides: Partial<SpendRequest> = {}): SpendRequest {
  return { token: USDC, spender: SPENDER, amount: "10.00", nowSeconds: 50_000, ...overrides };
}

describe("validateSpendPermission", () => {
  it("accepts a well-formed permission that covers the settlement", () => {
    expect(validateSpendPermission(permission(), request())).toEqual({ valid: true, failures: [] });
  });

  it("accepts the exact-allowance boundary (amount == allowance)", () => {
    const v = validateSpendPermission(
      permission({ allowance: "10.00" }),
      request({ amount: "10.00" }),
    );
    expect(v.valid).toBe(true);
  });

  it("rejects when the amount exceeds the allowance", () => {
    const v = validateSpendPermission(
      permission({ allowance: "10.00" }),
      request({ amount: "10.01" }),
    );
    expect(v.valid).toBe(false);
    expect(v.failures).toContain("amount exceeds the permission allowance");
  });

  it("rejects a token that is not the expected USDC address", () => {
    const v = validateSpendPermission(permission({ token: "0x" + "99".repeat(20) }), request());
    expect(v.valid).toBe(false);
    expect(v.failures).toContain(
      "token does not match the expected settlement asset (USDC on Base)",
    );
  });

  it("rejects a spender mismatch", () => {
    const v = validateSpendPermission(permission({ spender: "0x" + "99".repeat(20) }), request());
    expect(v.valid).toBe(false);
    expect(v.failures).toContain("spender does not match the expected settlement spender");
  });

  it("matches token + spender case-insensitively (0x prefix stays lowercase)", () => {
    const v = validateSpendPermission(
      permission({
        token: "0x" + USDC.slice(2).toUpperCase(),
        spender: "0x" + SPENDER.slice(2).toUpperCase(),
      }),
      request(),
    );
    expect(v.valid).toBe(true);
  });

  it("rejects before start and after end", () => {
    expect(validateSpendPermission(permission(), request({ nowSeconds: 500 })).failures).toContain(
      "permission is not yet valid",
    );
    expect(
      validateSpendPermission(permission(), request({ nowSeconds: 9_999_999 })).failures,
    ).toContain("permission has expired");
  });

  it("rejects malformed shapes (address / bytes32 / positivity / period / window)", () => {
    const v = validateSpendPermission(
      permission({
        account: "nope",
        salt: "0x12",
        allowance: "0",
        period: 0,
        end: 1, // < start
      }),
      request({ amount: "0" }),
    );
    expect(v.valid).toBe(false);
    expect(v.failures).toEqual(
      expect.arrayContaining([
        "account is not a 0x address",
        "salt is not a bytes32 hex",
        "allowance must be a positive decimal",
        "amount must be a positive decimal",
        "period must be a positive integer",
        "permission end is before its start",
      ]),
    );
  });

  it("compares amount vs allowance without float error (high precision)", () => {
    const ok = validateSpendPermission(
      permission({ allowance: "0.000001" }),
      request({ amount: "0.000001" }),
    );
    expect(ok.valid).toBe(true);
    const over = validateSpendPermission(
      permission({ allowance: "0.000001" }),
      request({ amount: "0.000002" }),
    );
    expect(over.failures).toContain("amount exceeds the permission allowance");
  });
});

describe("projections (RFC §7.5 mapping)", () => {
  it("toMicropaymentWindowCap mirrors allowance/period onto the §6 cap", () => {
    expect(toMicropaymentWindowCap(permission())).toEqual({
      currency: "USDC",
      value: "100.00",
      window_seconds: 86_400,
    });
  });

  it("toSessionKeyShape maps the permission onto BrainSmartAccount's session-key shape", () => {
    expect(toSessionKeyShape(permission())).toEqual({
      holder: SPENDER,
      maxPerPeriod: "100.00",
      periodSeconds: 86_400,
      validAfter: 1_000,
      validUntil: 2_000_000,
    });
  });
});
