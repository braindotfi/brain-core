/**
 * eth_getCode seam for the deployed-escrow-bytecode boot fence.
 *
 * Returns a `(address) => Promise<hex>` backed by a viem public client against
 * the Base RPC, so escrow-audit-gate.ts can verify the on-chain bytecode without
 * importing viem (and so tests can inject a fake fetcher instead).
 */

import { createPublicClient, http, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";

const BASE_MAINNET_CHAIN_ID = 8453;

export function makeBaseGetCode(
  rpcUrl: string,
  chainId: number,
): (address: string) => Promise<string> {
  const chain = chainId === BASE_MAINNET_CHAIN_ID ? base : baseSepolia;
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  return async (address: string): Promise<string> => {
    const code = await client.getCode({ address: address as Address });
    // viem returns undefined when there is no code at the address; the fence
    // treats "0x" as "no contract", which is a fail-closed mismatch.
    return code ?? "0x";
  };
}
