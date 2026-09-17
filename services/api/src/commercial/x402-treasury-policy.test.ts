import { describe, expect, it } from "vitest";
import {
  assertX402CustodyBindingAllowed,
  assertX402TreasuryIntentAllowed,
  assertX402OperationalBalanceAllowed,
  requireChecksummedAddress,
  shouldSweepX402TestUsdc,
  X402_BASE_SEPOLIA_CHAIN_ID,
  X402_BASE_MAINNET_CHAIN_ID,
  X402_SEPOLIA_BOOTSTRAP_ADDRESS_TAG,
  X402_TEST_USDC_OPERATIONAL_CEILING,
} from "./x402-treasury-policy.js";
import {
  X402_BASE_MAINNET_NETWORK,
  X402_BASE_SEPOLIA_NETWORK,
  X402_BASE_SEPOLIA_USDC,
} from "./x402-seller-protocol.js";

const destination = requireChecksummedAddress("0x1111111111111111111111111111111111111111");
const payer = requireChecksummedAddress("0x2222222222222222222222222222222222222222");
const policy = {
  approvedSweepDestination: destination,
  testUsdcOperationalCeiling: X402_TEST_USDC_OPERATIONAL_CEILING,
};

describe("x402 treasury signing policy", () => {
  it("binds the Premium-vault bootstrap to Base Sepolia and a versioned key", () => {
    const binding = {
      chainId: X402_BASE_SEPOLIA_CHAIN_ID,
      keyUri:
        "https://brain-x402-sepolia-kv.vault.azure.net/keys/brain-x402-sepolia-seller/version-one",
      addressClassification: X402_SEPOLIA_BOOTSTRAP_ADDRESS_TAG,
    };
    expect(() => assertX402CustodyBindingAllowed(binding)).not.toThrow();
    expect(() =>
      assertX402CustodyBindingAllowed({
        ...binding,
        keyUri: binding.keyUri.replace(/\/version-one$/, ""),
      }),
    ).toThrow(/exact versioned/);
    expect(() =>
      assertX402CustodyBindingAllowed({
        ...binding,
        keyUri:
          "https://brain-x402-sepolia.managedhsm.azure.net/keys/brain-x402-sepolia-seller/version-one",
      }),
    ).toThrow(/Premium/);
  });

  it("rejects the Premium bootstrap on Base mainnet and reserves mainnet for a new Managed HSM key", () => {
    const premiumBinding = {
      chainId: X402_BASE_MAINNET_CHAIN_ID,
      keyUri:
        "https://brain-x402-sepolia-kv.vault.azure.net/keys/brain-x402-sepolia-seller/version-one",
      addressClassification: X402_SEPOLIA_BOOTSTRAP_ADDRESS_TAG,
    };
    expect(() => assertX402CustodyBindingAllowed(premiumBinding)).toThrow(/rejects Key Vault/);
    expect(() =>
      assertX402CustodyBindingAllowed({
        ...premiumBinding,
        keyUri: "https://brain-mainnet-x402.managedhsm.azure.net/keys/new-mainnet-key/version-one",
        addressClassification: "x402_mainnet_reapproved",
      }),
    ).not.toThrow();
    expect(() =>
      assertX402CustodyBindingAllowed({
        ...premiumBinding,
        keyUri: "https://brain-mainnet-x402.managedhsm.azure.net/keys/new-mainnet-key/version-one",
      }),
    ).toThrow(/Sepolia bootstrap address/);
  });

  it("enforces the 1,000 test USDC ceiling and the 500-or-daily sweep policy", () => {
    expect(() => assertX402OperationalBalanceAllowed(1_000_000_001n)).toThrow(/1,000/);
    expect(
      shouldSweepX402TestUsdc({
        balanceAtomic: 500_000_000n,
        lastSweepAt: new Date("2026-09-16T11:59:59Z"),
        now: new Date("2026-09-16T12:00:00Z"),
      }),
    ).toBe(true);
    expect(
      shouldSweepX402TestUsdc({
        balanceAtomic: 1n,
        lastSweepAt: new Date("2026-09-15T12:00:00Z"),
        now: new Date("2026-09-16T12:00:00Z"),
      }),
    ).toBe(true);
    expect(
      shouldSweepX402TestUsdc({
        balanceAtomic: 499_999_999n,
        lastSweepAt: new Date("2026-09-16T11:00:00Z"),
        now: new Date("2026-09-16T12:00:00Z"),
      }),
    ).toBe(false);
  });

  it("allows only the approved sweep destination", () => {
    expect(() =>
      assertX402TreasuryIntentAllowed(
        {
          kind: "sweep",
          network: X402_BASE_SEPOLIA_NETWORK,
          chainId: X402_BASE_SEPOLIA_CHAIN_ID,
          asset: X402_BASE_SEPOLIA_USDC,
          destination,
          amountAtomic: 500_000_000n,
        },
        policy,
      ),
    ).not.toThrow();
    expect(() =>
      assertX402TreasuryIntentAllowed(
        {
          kind: "sweep",
          network: X402_BASE_SEPOLIA_NETWORK,
          chainId: X402_BASE_SEPOLIA_CHAIN_ID,
          asset: X402_BASE_SEPOLIA_USDC,
          destination: payer,
          amountAtomic: 1n,
        },
        policy,
      ),
    ).toThrow(/destination/);
  });

  it("allows only matching-amount refunds to the original payer", () => {
    const refund = {
      kind: "refund" as const,
      network: X402_BASE_SEPOLIA_NETWORK,
      chainId: X402_BASE_SEPOLIA_CHAIN_ID,
      asset: X402_BASE_SEPOLIA_USDC,
      destination: payer,
      amountAtomic: 10_000n,
      originalPayer: payer,
      originalSettlementAmountAtomic: 10_000n,
      receiptId: "x402rcpt_01M2B3C4D5E6F7G8H9JKMNPQRS",
    };
    expect(() => assertX402TreasuryIntentAllowed(refund, policy)).not.toThrow();
    expect(() =>
      assertX402TreasuryIntentAllowed({ ...refund, amountAtomic: 10_001n }, policy),
    ).toThrow(/exactly match/);
    expect(() => assertX402TreasuryIntentAllowed({ ...refund, destination }, policy)).toThrow(
      /exactly match/,
    );
  });

  it("rejects mainnet, another token, or amounts over the ceiling", () => {
    const sweep = {
      kind: "sweep" as const,
      network: X402_BASE_SEPOLIA_NETWORK,
      chainId: X402_BASE_SEPOLIA_CHAIN_ID,
      asset: X402_BASE_SEPOLIA_USDC,
      destination,
      amountAtomic: 1n,
    };
    expect(() =>
      assertX402TreasuryIntentAllowed(
        { ...sweep, network: X402_BASE_MAINNET_NETWORK as never },
        policy,
      ),
    ).toThrow(/Base Sepolia/);
    expect(() =>
      assertX402TreasuryIntentAllowed(
        { ...sweep, asset: "0x3333333333333333333333333333333333333333" as never },
        policy,
      ),
    ).toThrow(/pinned/);
    expect(() =>
      assertX402TreasuryIntentAllowed(
        { ...sweep, amountAtomic: X402_TEST_USDC_OPERATIONAL_CEILING + 1n },
        policy,
      ),
    ).toThrow(/exceeds/);
  });
});
