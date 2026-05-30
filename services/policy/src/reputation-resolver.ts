/**
 * ERC-8004 reputation resolver — reads BrainReputationRegistry on-chain
 * (RFC 0001 §7.7). Wired into PolicyService at boot so policy decisions
 * can tighten thresholds for low-reputation counterparties.
 *
 * The on-chain artifact is a Merkle root pointer only (no raw history, no
 * PII). For v1, any non-zero scoreRoot is treated as "attested" with a
 * neutral adjustment score (0.5 ∈ [0,1]). Off-chain score derivation from
 * the committed dataset is a follow-up (TODO: reputation-dataset).
 *
 * Reputation is NEVER a §6 pre-execution gate precondition (Standards §6,
 * Principle #5). It can only TIGHTEN policy decisions.
 *
 * Env: BRAIN_REPUTATION_REGISTRY_ADDRESS must be set; otherwise
 * resolveReputation is not injected and PolicyService applies no adjustment.
 */

import { createPublicClient, http, parseAbi } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { ReputationResolver } from "./reputation.js";

const REPUTATION_ABI = parseAbi([
  "function reputationOf(bytes32 agentId) external view returns (bytes32 scoreRoot, uint64 epoch, uint64 updatedAt)",
]);

export function makeResolveReputation(opts: {
  registryAddress: string;
  rpcUrl: string;
  chainId?: number;
}): ReputationResolver {
  const chain = opts.chainId === 8453 ? base : baseSepolia;
  const client = createPublicClient({ chain, transport: http(opts.rpcUrl) });

  return async function resolveReputation(_ctx, counterpartyId) {
    try {
      const [scoreRoot, epoch] = await client.readContract({
        address: opts.registryAddress as `0x${string}`,
        abi: REPUTATION_ABI,
        functionName: "reputationOf",
        args: [counterpartyId as `0x${string}`],
      });

      if (
        epoch === 0n ||
        scoreRoot === "0x0000000000000000000000000000000000000000000000000000000000000000"
      ) {
        return null;
      }

      // TODO(reputation-dataset): derive numeric score from off-chain dataset
      // committed to scoreRoot. Until then: any published pointer → neutral score.
      return { score: 0.5, source: scoreRoot };
    } catch {
      return null;
    }
  };
}
