import { describe, expect, it } from "vitest";
import {
  fromScaled,
  isBalanced,
  netImbalance,
  toScaled,
  totalsByDirection,
  type DirectionalAmount,
} from "./balance.js";

describe("toScaled / fromScaled", () => {
  it("round-trips plain decimals at 8-dp scale", () => {
    expect(fromScaled(toScaled("1250.00"))).toBe("1250.00000000");
    expect(fromScaled(toScaled("0"))).toBe("0.00000000");
    expect(fromScaled(toScaled("-42.5"))).toBe("-42.50000000");
  });

  it("is exact across values that would drift as floats", () => {
    // 0.1 + 0.2 !== 0.3 in float; scaled bigint arithmetic is exact.
    const sum = toScaled("0.1") + toScaled("0.2");
    expect(fromScaled(sum)).toBe("0.30000000");
  });

  it("rejects non-decimal and over-precise input rather than coercing", () => {
    expect(() => toScaled("1,250.00")).toThrow(/plain decimal/);
    expect(() => toScaled("1e3")).toThrow(/plain decimal/);
    expect(() => toScaled("1.123456789")).toThrow(/fractional digits/);
  });
});

describe("totalsByDirection / netImbalance / isBalanced", () => {
  const balanced: DirectionalAmount[] = [
    { direction: "debit", amount: "1250.00" },
    { direction: "credit", amount: "1000.00" },
    { direction: "credit", amount: "250.00" },
  ];

  it("sums each side independently", () => {
    expect(totalsByDirection(balanced)).toEqual({
      debit: "1250.00000000",
      credit: "1250.00000000",
    });
  });

  it("reports a zero imbalance for a balanced entry", () => {
    expect(netImbalance(balanced)).toBe("0.00000000");
    expect(isBalanced(balanced)).toBe(true);
  });

  it("surfaces the signed imbalance when debits and credits disagree", () => {
    const lopsided: DirectionalAmount[] = [
      { direction: "debit", amount: "100.00" },
      { direction: "credit", amount: "99.50" },
    ];
    expect(netImbalance(lopsided)).toBe("0.50000000");
    expect(isBalanced(lopsided)).toBe(false);
  });

  it("treats an empty entry as trivially balanced", () => {
    expect(isBalanced([])).toBe(true);
  });
});
