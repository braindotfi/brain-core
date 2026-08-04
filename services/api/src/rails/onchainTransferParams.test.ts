/**
 * Regression tests for resolveOnchainTransferParams (F3 + F4).
 *
 * F4: recipient must come from counterparty.onchain_address, never a scan
 * over `aliases` (aliases is not even part of this function's input anymore
 * -- that is the fix: the caller no longer has a way to fall back to it).
 *
 * F3: a token-currency transfer must produce real ERC-20 transfer() calldata
 * (`a9059cbb` selector) against the token contract, carrying the right
 * amount -- not `data: "0x"` against the payee with a zero value.
 */

import { describe, expect, it, vi } from "vitest";
import { resolveOnchainTransferParams } from "./onchainTransferParams.js";

const SMART_ACCOUNT = "0xe2e812ce1c52e80fc00079432d9ffac8f14d847c";
const HOLDER = "0xe9976320e5ed9f21b8defbe2b311d5654fe24023";
const POLICY_VERSION = "0x" + "3".repeat(64);
const USDC = "0x0694f60e8a3e6f89cb907ab479c9e4469edba2e7";
const PAYEE = "0xc01394351ad397ac4c141dcea94fbfa39444427c";

const baseCfg = {
  smartAccount: SMART_ACCOUNT,
  holder: HOLDER,
  policyVersion: POLICY_VERSION,
  usdcAddress: USDC,
  getUsdcDecimals: vi.fn().mockResolvedValue(6),
};

describe("resolveOnchainTransferParams", () => {
  it("F4: uses counterparty.onchain_address as the recipient", async () => {
    const out = await resolveOnchainTransferParams(
      { onchain_address: PAYEE },
      { amount: "1", currency: "ETH" },
      baseCfg,
    );
    expect(out?.target).toBe(PAYEE);
  });

  it("F4: refuses to dispatch when onchain_address is absent (no aliases fallback)", async () => {
    const out = await resolveOnchainTransferParams(
      { onchain_address: null },
      { amount: "1", currency: "ETH" },
      baseCfg,
    );
    expect(out).toBeNull();
  });

  it("F4: refuses a malformed onchain_address", async () => {
    const out = await resolveOnchainTransferParams(
      { onchain_address: "not-an-address" },
      { amount: "1", currency: "ETH" },
      baseCfg,
    );
    expect(out).toBeNull();
  });

  it("ETH currency: native value transfer, empty calldata (unchanged behavior)", async () => {
    const out = await resolveOnchainTransferParams(
      { onchain_address: PAYEE },
      { amount: "1.5", currency: "eth" },
      baseCfg,
    );
    expect(out).toEqual({
      smart_account: SMART_ACCOUNT,
      holder: HOLDER,
      target: PAYEE,
      data: "0x",
      value: "1500000000000000000",
      policy_version: POLICY_VERSION,
    });
  });

  it("F3: USDC currency encodes a real ERC-20 transfer() call against the token contract", async () => {
    const getUsdcDecimals = vi.fn().mockResolvedValue(6);
    const out = await resolveOnchainTransferParams(
      { onchain_address: PAYEE },
      { amount: "100.50", currency: "USDC" },
      { ...baseCfg, getUsdcDecimals },
    );
    expect(out).not.toBeNull();
    expect(out?.target).toBe(USDC); // the token contract, not the payee
    expect(out?.value).toBe("0"); // no native value; amount is in calldata
    expect(out?.data.startsWith("0xa9059cbb")).toBe(true); // transfer(address,uint256) selector
    expect(out?.data.toLowerCase()).toContain(PAYEE.slice(2).toLowerCase().padStart(64, "0"));
    // 100.50 USDC at 6 decimals = 100_500_000 = 0x5fd8220
    expect(out?.data.toLowerCase().endsWith("5fd8220")).toBe(true);
  });

  it("F3: an unconfigured/unknown token currency fails closed (no address to guess)", async () => {
    const out = await resolveOnchainTransferParams(
      { onchain_address: PAYEE },
      { amount: "1", currency: "EUR" },
      baseCfg,
    );
    expect(out).toBeNull();
  });

  it("F3: USDC with no configured token address fails closed", async () => {
    const out = await resolveOnchainTransferParams(
      { onchain_address: PAYEE },
      { amount: "1", currency: "USDC" },
      { ...baseCfg, usdcAddress: undefined, getUsdcDecimals: undefined },
    );
    expect(out).toBeNull();
  });
});
