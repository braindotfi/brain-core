/**
 * Resolves the on-chain dispatch params for an `onchain_transfer` intent.
 *
 * Pulled out of main.ts's `resolveOnchainParams` closure so the two bugs it
 * carried are independently unit-testable:
 *
 * F4 -- the recipient is `counterparty.onchain_address`, the SAME field the
 * §6 gate binds for x402_settle (check 6.5) and escrow_release (check 6.6).
 * The prior code scanned the counterparty's `aliases` array for anything
 * address-shaped, but `aliases` is a free-form identity field an agent
 * principal can PATCH via /ledger/counterparties -- `onchain_address` is not
 * PATCH-able on that route at all. Refuses to dispatch (returns null) when
 * onchain_address is absent or malformed, rather than falling back.
 *
 * F3 -- any non-ETH currency needs real ERC-20 `transfer(address,uint256)`
 * calldata against the token contract, not `data: "0x"` against the payee.
 * USDC is the only ERC-20 this deployment has a configured contract address
 * for (BRAIN_X402_USDC_ADDRESS); any other currency fails closed (null)
 * rather than guessing a token address. Decimals are read live via the
 * injected `getUsdcDecimals`, never hardcoded.
 */

import { encodeFunctionData, parseAbi, parseEther, parseUnits } from "viem";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ERC20_TRANSFER_ABI = parseAbi([
  "function transfer(address to, uint256 amount) external returns (bool)",
]);

export interface OnchainTransferCounterparty {
  onchain_address: string | null;
}

export interface OnchainTransferIntent {
  amount: string;
  currency: string;
}

export interface OnchainTransferConfig {
  smartAccount: string;
  holder: string;
  policyVersion: string;
  /** BRAIN_X402_USDC_ADDRESS. Undefined when unconfigured -- non-ETH fails closed. */
  usdcAddress: string | undefined;
  /** Reads decimals() off usdcAddress. Undefined when usdcAddress is unset. */
  getUsdcDecimals: ((tokenAddress: string) => Promise<number>) | undefined;
}

export interface OnchainDispatchParamsLike {
  smart_account: string;
  holder: string;
  target: string;
  data: string;
  value: string;
  policy_version: string;
}

export async function resolveOnchainTransferParams(
  cp: OnchainTransferCounterparty,
  intent: OnchainTransferIntent,
  cfg: OnchainTransferConfig,
): Promise<OnchainDispatchParamsLike | null> {
  const target = cp.onchain_address;
  if (target === null || !ADDRESS.test(target)) return null;

  const currency = intent.currency.toUpperCase();

  if (currency === "ETH") {
    return {
      smart_account: cfg.smartAccount,
      holder: cfg.holder,
      target,
      data: "0x",
      value: parseEther(intent.amount).toString(),
      policy_version: cfg.policyVersion,
    };
  }

  if (currency !== "USDC" || cfg.usdcAddress === undefined || cfg.getUsdcDecimals === undefined) {
    return null;
  }
  const decimals = await cfg.getUsdcDecimals(cfg.usdcAddress);
  const amountUnits = parseUnits(intent.amount, decimals);
  return {
    smart_account: cfg.smartAccount,
    holder: cfg.holder,
    target: cfg.usdcAddress,
    data: encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [target as `0x${string}`, amountUnits],
    }),
    value: "0",
    policy_version: cfg.policyVersion,
  };
}
