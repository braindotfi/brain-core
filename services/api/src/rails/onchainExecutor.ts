/**
 * Factory for the on-chain executor used by OnchainBaseRail at boot.
 *
 * Production signs via Azure Key Vault (BRAIN_AZURE_KEY_VAULT_URL). For
 * testnet (Base Sepolia), set BRAIN_SESSION_KEY (a 0x-prefixed 32-byte hex
 * private key) instead — the key is loaded directly via privateKeyToAccount.
 * Never set BRAIN_SESSION_KEY in production; use the Key Vault path instead.
 *
 * Env: BRAIN_SESSION_KEY, BASE_RPC_URL, BRAIN_BASE_CHAIN_ID (default 84532).
 */

import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { OnchainExecutor, OnchainExecuteArgs, OnchainExecuteResult } from "@brain/execution";

const BRAIN_SMART_ACCOUNT_ABI = parseAbi([
  "function nonce(address holder) external view returns (uint256)",
  "function executeViaSessionKey(uint256 nonceSupplied, address target, uint256 value, bytes calldata data) external",
]);

/** Returns the public address for a given session private key (hex). */
export function getHolderAddress(privateKey: `0x${string}`): string {
  return privateKeyToAccount(privateKey).address;
}

export function buildOnchainExecutor(opts: {
  privateKey: `0x${string}`;
  rpcUrl: string;
  chainId?: number;
}): OnchainExecutor {
  const chain = opts.chainId === 8453 ? base : baseSepolia;
  const account = privateKeyToAccount(opts.privateKey);
  const publicClient = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(opts.rpcUrl) });

  return {
    async readNonce(args: { smartAccount: string; holder: string }): Promise<bigint> {
      return publicClient.readContract({
        address: args.smartAccount as `0x${string}`,
        abi: BRAIN_SMART_ACCOUNT_ABI,
        functionName: "nonce",
        args: [args.holder as `0x${string}`],
      });
    },
    async execute(args: OnchainExecuteArgs): Promise<OnchainExecuteResult> {
      const hash = await walletClient.writeContract({
        address: args.smartAccount as `0x${string}`,
        abi: BRAIN_SMART_ACCOUNT_ABI,
        functionName: "executeViaSessionKey",
        args: [args.nonce, args.target as `0x${string}`, args.value, args.data as `0x${string}`],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return {
        txHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      };
    },
  };
}
