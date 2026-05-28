/**
 * Concrete X402Client builder wired at boot.
 *
 * Implements the x402 HTTP settlement protocol: a POST to the facilitator URL
 * with the payment details; the facilitator verifies the on-chain USDC transfer
 * has been initiated and returns a tx_hash. The rail file (x402-base.ts) stays
 * SDK-free and uses this injected client.
 *
 * Env: BRAIN_X402_FACILITATOR_URL, BRAIN_X402_USDC_ADDRESS, BRAIN_X402_NETWORK.
 * Session key signs the USDC transfer on behalf of the tenant's smart account.
 */

import { createPublicClient, createWalletClient, http, parseUnits, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { X402Client, X402SettleArgs, X402SettleResult } from "@brain/execution";

const USDC_ABI = parseAbi([
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function decimals() external view returns (uint8)",
]);

export function buildX402Client(opts: {
  facilitatorUrl: string;
  usdcAddress: string;
  network: string;
  privateKey: `0x${string}`;
  rpcUrl: string;
  chainId?: number;
}): X402Client {
  const chain = opts.chainId === 8453 ? base : baseSepolia;
  const account = privateKeyToAccount(opts.privateKey);
  const publicClient = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(opts.rpcUrl) });

  return {
    async settle(args: X402SettleArgs): Promise<X402SettleResult> {
      // 1. Read USDC decimals (6 for USDC, cached by viem).
      const decimals = await publicClient.readContract({
        address: opts.usdcAddress as `0x${string}`,
        abi: USDC_ABI,
        functionName: "decimals",
      });

      // 2. Transfer USDC from the session-key account to the payee.
      const amountUnits = parseUnits(args.amount, decimals);
      const txHash = await walletClient.writeContract({
        address: opts.usdcAddress as `0x${string}`,
        abi: USDC_ABI,
        functionName: "transfer",
        args: [args.payTo as `0x${string}`, amountUnits],
      });

      // 3. Wait for receipt.
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      // 4. Notify the facilitator for settlement attestation / bookkeeping.
      //    If the facilitator is unreachable, we still have the confirmed tx —
      //    the settlement is recorded; the facilitator step is best-effort.
      try {
        const resp = await fetch(opts.facilitatorUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tx_hash: receipt.transactionHash,
            pay_to: args.payTo,
            amount: args.amount,
            asset: "USDC",
            network: opts.network,
            idempotency_key: args.idempotencyKey,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          // Log but don't throw — the on-chain transfer is the source of truth.
          console.warn(
            `[x402Client] facilitator notification failed: ${resp.status} ${resp.statusText}`,
          );
        }
      } catch (err) {
        console.warn(`[x402Client] facilitator notification error: ${String(err)}`);
      }

      return {
        txHash: receipt.transactionHash,
        settledAmount: args.amount,
      };
    },
  };
}
