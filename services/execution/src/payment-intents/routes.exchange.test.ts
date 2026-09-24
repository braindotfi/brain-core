import { describe, expect, it } from "vitest";
import { isAcceptedActionType, isValidCurrency } from "./routes.js";

describe("payment intent exchange route contract", () => {
  it("accepts exchange as a first-class action type", () => {
    expect(isAcceptedActionType("exchange")).toBe(true);
  });

  it("allows token-style exchange currency codes", () => {
    expect(isValidCurrency("exchange", "ETH")).toBe(true);
    expect(isValidCurrency("exchange", "USDC")).toBe(true);
    expect(isValidCurrency("exchange", "usd")).toBe(false);
  });
});
