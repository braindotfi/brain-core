/**
 * Gate check 6.6 — on-chain escrow-state resolver (RFC 0001 §6.2 / §7.6).
 *
 * Reads `BrainEscrow.getEscrow(escrowId)` via viem to confirm the on-chain
 * lock matches the PaymentIntent before a release is authorized. Injected
 * into PaymentIntentService at boot; the gate (shared/src/gate/gate.ts:582)
 * hard-rejects when the escrow state, remaining balance, jobTermsHash, or
 * payee don't match the intent.
 *
 * Returns null when the escrowId is unknown on-chain (zero-struct: payer == address(0)).
 *
 * Env: BRAIN_ESCROW_ADDRESS must be set; otherwise resolveEscrowState is not
 * injected and check 6.6 stays dormant.
 */

import { createPublicClient, http, parseAbi, formatUnits } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { EscrowStateInput, ResolvedEscrowState } from "@brain/shared";
import type { ServiceCallContext } from "@brain/shared";

const ESCROW_ABI = parseAbi([
  "function getEscrow(bytes32 escrowId) external view returns (address payer, address payee, address token, uint256 amount, uint256 released, uint256 refunded, bytes32 jobTermsHash, uint64 deadline, uint8 state)",
]);

// BrainEscrow.State: None=0, Locked=1, Settled=2.
const ESCROW_STATE_MAP: Record<number, "None" | "Locked" | "Settled"> = {
  0: "None",
  1: "Locked",
  2: "Settled",
};

// USDC uses 6 decimals on Base.
const USDC_DECIMALS = 6;

export function makeResolveEscrowState(opts: {
  escrowAddress: string;
  rpcUrl: string;
  chainId?: number;
}): (ctx: ServiceCallContext, input: EscrowStateInput) => Promise<ResolvedEscrowState | null> {
  const chain = opts.chainId === 8453 ? base : baseSepolia;
  const client = createPublicClient({ chain, transport: http(opts.rpcUrl) });

  return async function resolveEscrowState(
    _ctx: ServiceCallContext,
    input: EscrowStateInput,
  ): Promise<ResolvedEscrowState | null> {
    const [payer, payee, token, amount, released, refunded, jobTermsHash, , stateRaw] =
      await client.readContract({
        address: opts.escrowAddress as `0x${string}`,
        abi: ESCROW_ABI,
        functionName: "getEscrow",
        args: [input.escrowId as `0x${string}`],
      });

    // A zero-payer means the escrow id has never been locked.
    if (payer === "0x0000000000000000000000000000000000000000") return null;

    const remaining = amount - released - refunded;
    const state = ESCROW_STATE_MAP[Number(stateRaw)] ?? "None";

    return {
      state,
      payer,
      payee,
      token,
      amount: formatUnits(amount, USDC_DECIMALS),
      released: formatUnits(released, USDC_DECIMALS),
      refunded: formatUnits(refunded, USDC_DECIMALS),
      remaining: formatUnits(remaining, USDC_DECIMALS),
      jobTermsHash,
    };
  };
}
