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

import { createPublicClient, createWalletClient, http, parseAbi, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { OnchainExecutor, OnchainExecuteArgs, OnchainExecuteResult } from "@brain/execution";

const BRAIN_SMART_ACCOUNT_ABI = parseAbi([
  "function nonce(address holder) external view returns (uint256)",
  "function executeViaSessionKey(uint256 nonceSupplied, address target, uint256 value, bytes calldata data) external",
]);

/**
 * Base Sepolia's `eth_gasPrice` can report a sub-0.01-gwei value, which viem
 * turns into a maxPriorityFeePerGas so low the tx never gets mined; the outbox
 * worker then retries at the same price and the node rejects each one with
 * "replacement transaction underpriced", so the settlement never lands. Floor
 * the EIP-1559 fees to a sane minimum so the tx is includable AND a retry can
 * replace a stuck cheaper tx (>10% bump). Overridable via env for other chains.
 */
function gweiFloor(envName: string, defaultGwei: string): bigint {
  const raw = process.env[envName];
  const value = raw !== undefined && raw.trim() !== "" ? raw.trim() : defaultGwei;
  const n = Number(value);
  return parseGwei(Number.isFinite(n) && n > 0 ? value : defaultGwei);
}

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
      // Floor the fees (see gweiFloor doc) and take the max of the network
      // estimate and the floor so we never under-price below inclusion.
      const minPriority = gweiFloor("BRAIN_ONCHAIN_MIN_PRIORITY_FEE_GWEI", "1.5");
      const minMaxFee = gweiFloor("BRAIN_ONCHAIN_MIN_MAX_FEE_GWEI", "3");
      let maxPriorityFeePerGas = minPriority;
      let maxFeePerGas = minMaxFee;
      try {
        const est = await publicClient.estimateFeesPerGas();
        if (est.maxPriorityFeePerGas > maxPriorityFeePerGas) {
          maxPriorityFeePerGas = est.maxPriorityFeePerGas;
        }
        if (est.maxFeePerGas > maxFeePerGas) {
          maxFeePerGas = est.maxFeePerGas;
        }
      } catch {
        // estimateFeesPerGas can fail on some RPCs; the floors above are a safe
        // fallback for Base Sepolia.
      }
      if (maxFeePerGas < maxPriorityFeePerGas) {
        maxFeePerGas = maxPriorityFeePerGas;
      }
      const hash = await walletClient.writeContract({
        address: args.smartAccount as `0x${string}`,
        abi: BRAIN_SMART_ACCOUNT_ABI,
        functionName: "executeViaSessionKey",
        args: [args.nonce, args.target as `0x${string}`, args.value, args.data as `0x${string}`],
        maxFeePerGas,
        maxPriorityFeePerGas,
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
