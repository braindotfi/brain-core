/**
 * Boot fence: the configured x402/escrow settlement token must actually be
 * 6-decimal.
 *
 * `services/policy/src/escrow-resolver.ts`'s `SETTLEMENT_DECIMALS = 6` and
 * `PaymentIntentService.ts`'s `escrow_release` payload (multiply by
 * `1_000_000n`) both hardcode 6 decimals for whatever `BRAIN_X402_USDC_ADDRESS`
 * is configured to. Neither reads `decimals()` off that token. If it is ever
 * pointed at an 18-decimal token, check 6.6 approves against a `remaining`
 * inflated by 10^12 while the rail releases 10^-12 of the intent -- the exact
 * decimals mismatch escrow-resolver.ts's `assetMatchesSettlement` binding
 * exists to prevent for the ESCROW side, reintroduced on the CONFIGURED side.
 *
 * Read `decimals()` once at boot and fail closed unless it is 6, rather than
 * threading the real value through two independently-written call sites.
 */

import { createPublicClient, http, parseAbi, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";

const BASE_MAINNET_CHAIN_ID = 8453;

const ERC20_DECIMALS_ABI = parseAbi(["function decimals() external view returns (uint8)"]);

/** viem seam so the fence itself never imports a chain/RPC client directly. */
export function makeBaseGetErc20Decimals(
  rpcUrl: string,
  chainId: number,
): (tokenAddress: string) => Promise<number> {
  const chain = chainId === BASE_MAINNET_CHAIN_ID ? base : baseSepolia;
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  return async (tokenAddress: string): Promise<number> => {
    const decimals = await client.readContract({
      address: tokenAddress as Address,
      abi: ERC20_DECIMALS_ABI,
      functionName: "decimals",
    });
    return Number(decimals);
  };
}

export interface SettlementDecimalsGateInput {
  /** BRAIN_X402_USDC_ADDRESS. No-op (nothing to check) when unset. */
  tokenAddress: string | undefined;
  getDecimals: (tokenAddress: string) => Promise<number>;
}

const REQUIRED_DECIMALS = 6;

export async function assertSettlementTokenIsSixDecimals(
  input: SettlementDecimalsGateInput,
): Promise<void> {
  if (input.tokenAddress === undefined) return;
  const decimals = await input.getDecimals(input.tokenAddress);
  if (decimals !== REQUIRED_DECIMALS) {
    throw new Error(
      `BRAIN_X402_USDC_ADDRESS (${input.tokenAddress}) reports decimals()=${decimals}, but ` +
        `escrow-resolver.ts and PaymentIntentService.ts both hardcode ${REQUIRED_DECIMALS} ` +
        "decimals for the settlement asset. Refusing to start: with any other decimals count, " +
        "check 6.6's remaining-balance comparison and the escrow_release base-unit conversion " +
        "would be off by a power of ten in opposite directions.",
    );
  }
}
