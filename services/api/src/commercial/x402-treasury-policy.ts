import { getAddress, isAddress, type Address } from "viem";
import { X402_BASE_SEPOLIA_NETWORK, X402_BASE_SEPOLIA_USDC } from "./x402-seller-protocol.js";

export const X402_BASE_SEPOLIA_CHAIN_ID = 84_532 as const;
export const X402_BASE_MAINNET_CHAIN_ID = 8_453 as const;
export const X402_SEPOLIA_BOOTSTRAP_ADDRESS_TAG = "x402_sepolia_bootstrap_only" as const;
export const X402_TEST_USDC_OPERATIONAL_CEILING = 1_000_000_000n;
export const X402_TEST_USDC_SWEEP_THRESHOLD = 500_000_000n;
export const X402_TEST_USDC_MAX_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type X402TreasuryIntent =
  | {
      readonly kind: "sweep";
      readonly network: typeof X402_BASE_SEPOLIA_NETWORK;
      readonly chainId: typeof X402_BASE_SEPOLIA_CHAIN_ID;
      readonly asset: typeof X402_BASE_SEPOLIA_USDC;
      readonly destination: Address;
      readonly amountAtomic: bigint;
    }
  | {
      readonly kind: "refund";
      readonly network: typeof X402_BASE_SEPOLIA_NETWORK;
      readonly chainId: typeof X402_BASE_SEPOLIA_CHAIN_ID;
      readonly asset: typeof X402_BASE_SEPOLIA_USDC;
      readonly destination: Address;
      readonly amountAtomic: bigint;
      readonly originalPayer: Address;
      readonly originalSettlementAmountAtomic: bigint;
      readonly receiptId: string;
    };

export interface X402TreasuryPolicy {
  readonly approvedSweepDestination: Address;
  readonly testUsdcOperationalCeiling: bigint;
}

export interface X402CustodyBinding {
  readonly chainId: number;
  readonly keyUri: string;
  readonly addressClassification: string;
}

/**
 * Fail closed before any signer is constructed. Premium Key Vault is an
 * explicitly temporary Base Sepolia custody backend. A future Base mainnet
 * signer must use a new Managed HSM key and a separate reviewed address.
 */
export function assertX402CustodyBindingAllowed(binding: X402CustodyBinding): void {
  let uri: URL;
  try {
    uri = new URL(binding.keyUri);
  } catch {
    throw new Error("x402 custody key URI must be a valid HTTPS Azure key URI");
  }
  if (uri.protocol !== "https:" || !/^\/keys\/[^/]+\/[^/]+$/.test(uri.pathname)) {
    throw new Error("x402 custody key URI must identify an exact versioned Azure key");
  }

  const host = uri.hostname.toLowerCase();
  const isPremiumVault = host.endsWith(".vault.azure.net");
  const isManagedHsm = host.endsWith(".managedhsm.azure.net");

  if (binding.chainId === X402_BASE_SEPOLIA_CHAIN_ID) {
    if (!isPremiumVault || isManagedHsm) {
      throw new Error("Base Sepolia bootstrap requires a Key Vault Premium key URI");
    }
    if (binding.addressClassification !== X402_SEPOLIA_BOOTSTRAP_ADDRESS_TAG) {
      throw new Error("Base Sepolia bootstrap address must carry its custody classification");
    }
    return;
  }

  if (binding.chainId === X402_BASE_MAINNET_CHAIN_ID) {
    if (isPremiumVault) {
      throw new Error("Base mainnet rejects Key Vault Premium custody");
    }
    if (!isManagedHsm) {
      throw new Error("Base mainnet requires a new Azure Managed HSM key URI");
    }
    if (binding.addressClassification === X402_SEPOLIA_BOOTSTRAP_ADDRESS_TAG) {
      throw new Error("Base mainnet rejects the Sepolia bootstrap address");
    }
    return;
  }

  throw new Error("x402 custody is not approved for this chain id");
}

export function assertX402OperationalBalanceAllowed(balanceAtomic: bigint): void {
  if (balanceAtomic < 0n || balanceAtomic > X402_TEST_USDC_OPERATIONAL_CEILING) {
    throw new Error("x402 seller balance exceeds the 1,000 test USDC operational ceiling");
  }
}

export function shouldSweepX402TestUsdc(input: {
  readonly balanceAtomic: bigint;
  readonly lastSweepAt: Date | null;
  readonly now: Date;
}): boolean {
  assertX402OperationalBalanceAllowed(input.balanceAtomic);
  if (input.balanceAtomic === 0n) return false;
  if (input.balanceAtomic >= X402_TEST_USDC_SWEEP_THRESHOLD) return true;
  return (
    input.lastSweepAt === null ||
    input.now.getTime() - input.lastSweepAt.getTime() >= X402_TEST_USDC_MAX_SWEEP_INTERVAL_MS
  );
}

/**
 * The HSM role can limit the identity to sign on one key. This policy is the
 * semantic boundary that prevents arbitrary chain, token, calldata, and
 * request-supplied destination signing.
 */
export function assertX402TreasuryIntentAllowed(
  intent: X402TreasuryIntent,
  policy: X402TreasuryPolicy,
): void {
  if (
    intent.network !== X402_BASE_SEPOLIA_NETWORK ||
    intent.chainId !== X402_BASE_SEPOLIA_CHAIN_ID
  ) {
    throw new Error("x402 treasury signing is restricted to Base Sepolia");
  }
  if (getAddress(intent.asset) !== getAddress(X402_BASE_SEPOLIA_USDC)) {
    throw new Error("x402 treasury signing is restricted to pinned Base Sepolia USDC");
  }
  if (intent.amountAtomic <= 0n || intent.amountAtomic > policy.testUsdcOperationalCeiling) {
    throw new Error("x402 treasury amount exceeds the test USDC policy");
  }
  if (intent.kind === "sweep") {
    if (getAddress(intent.destination) !== getAddress(policy.approvedSweepDestination)) {
      throw new Error("x402 sweep destination is not approved");
    }
    return;
  }
  if (
    getAddress(intent.destination) !== getAddress(intent.originalPayer) ||
    intent.amountAtomic !== intent.originalSettlementAmountAtomic ||
    intent.receiptId.trim().length === 0
  ) {
    throw new Error("x402 refund must exactly match the original payer and amount");
  }
}

export function requireChecksummedAddress(value: string): Address {
  if (!isAddress(value, { strict: true }) || getAddress(value) !== value) {
    throw new Error("address must be a valid checksummed EVM address");
  }
  return value;
}
