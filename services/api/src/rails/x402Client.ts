/**
 * Concrete X402Client builder wired at boot.
 *
 * Implements the x402 HTTP settlement protocol: settle the USDC transfer
 * on-chain, then POST the result to the facilitator URL for attestation /
 * bookkeeping. The rail file (x402-base.ts) stays SDK-free and uses this
 * injected client.
 *
 * F1: the settlement itself is routed through the injected `OnchainExecutor`
 * (`BrainSmartAccount.executeViaSessionKey`) instead of a bare session-key EOA
 * signing an ERC-20 transfer directly. A direct transfer bypasses every
 * on-chain guard the contract enforces (allowedTargets, allowedSelectors,
 * maxPerTx/maxPerPeriod, the policyVersion binding, the _nonces replay guard,
 * the pause kill switches) -- CLAUDE.md's safety argument for why x402
 * intentionally skips ledger_reservations is that "their spend ceilings are
 * the on-chain session-key caps"; a direct transfer had no ceiling at all.
 * This is the same executor + smart-account routing EscrowBaseRail already
 * uses for escrow_release (services/execution/src/rails/escrow-base.ts).
 *
 * Reverted-receipt handling (F2) lives once in the shared executor
 * (onchainExecutor.ts's `execute`), so it applies here too now that this
 * client routes through it -- no separate unchecked receipt wait remains.
 *
 * Env: BRAIN_X402_FACILITATOR_URL, BRAIN_X402_USDC_ADDRESS, BRAIN_X402_NETWORK,
 * BRAIN_ONCHAIN_SMART_ACCOUNT. Session key signs on behalf of the tenant's
 * smart account.
 */

import { encodeFunctionData, parseAbi, parseUnits } from "viem";
import type {
  OnchainExecutor,
  X402Client,
  X402SettleArgs,
  X402SettleResult,
} from "@brain/execution";

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) external returns (bool)",
]);

export interface BuildX402ClientOpts {
  facilitatorUrl: string;
  usdcAddress: string;
  network: string;
  /** Shared on-chain executor (same one OnchainBaseRail/EscrowBaseRail use). */
  executor: OnchainExecutor;
  /** 0x 20-byte BrainSmartAccount address the session key executes through. */
  smartAccount: string;
  /** 0x 20-byte session-key holder (the signer) address. */
  holderAddress: string;
  /** Reads USDC.decimals() -- injected so this module stays viem-client-light. */
  getUsdcDecimals: (tokenAddress: string) => Promise<number>;
}

export function buildX402Client(opts: BuildX402ClientOpts): X402Client {
  return {
    async settle(args: X402SettleArgs): Promise<X402SettleResult> {
      // 1. Read USDC decimals and encode the ERC-20 transfer calldata.
      const decimals = await opts.getUsdcDecimals(opts.usdcAddress);
      const amountUnits = parseUnits(args.amount, decimals);
      const data = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [args.payTo as `0x${string}`, amountUnits],
      });

      // 2. Route the transfer through BrainSmartAccount.executeViaSessionKey
      //    so the on-chain caps and replay guard apply (F1).
      const nonce = await opts.executor.readNonce({
        smartAccount: opts.smartAccount,
        holder: opts.holderAddress,
      });
      const result = await opts.executor.execute({
        smartAccount: opts.smartAccount,
        holder: opts.holderAddress,
        nonce,
        target: opts.usdcAddress,
        value: 0n,
        data,
      });

      // 3. Notify the facilitator for settlement attestation / bookkeeping.
      //    If the facilitator is unreachable, we still have the confirmed tx --
      //    the settlement is recorded; the facilitator step is best-effort.
      try {
        const resp = await fetch(opts.facilitatorUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tx_hash: result.txHash,
            pay_to: args.payTo,
            amount: args.amount,
            asset: "USDC",
            network: opts.network,
            idempotency_key: args.idempotencyKey,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          // Log but don't throw -- the on-chain transfer is the source of truth.
          console.warn(
            `[x402Client] facilitator notification failed: ${resp.status} ${resp.statusText}`,
          );
        }
      } catch (err) {
        console.warn(`[x402Client] facilitator notification error: ${String(err)}`);
      }

      return {
        txHash: result.txHash,
        settledAmount: args.amount,
      };
    },
  };
}
