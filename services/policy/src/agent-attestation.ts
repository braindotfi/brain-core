/**
 * Gate check 5.5 — agent-counterparty attestation loader (RFC 0001 §6.3).
 *
 * Reads `BrainMCPAgentRegistry.getAgent(agentId)` via viem to confirm the
 * payee agent is registered, attested, and not revoked. Injected into
 * PaymentIntentService at boot; the gate (shared/src/gate/gate.ts:495) hard-
 * rejects a paused or unregistered agent payee when this loader is present.
 *
 * 60-second in-memory TTL cache keyed by agentId — mirrors the MCP auth
 * check in services/api/src/auth/siwx.ts. An agent revocation propagates
 * within one cache TTL.
 */

import { createPublicClient, http, parseAbi } from "viem";
import { baseSepolia, base } from "viem/chains";
import type {
  AgentAttestationInput,
  AgentAttestationResult,
  ServiceCallContext,
} from "@brain/shared";

const REGISTRY_ABI = parseAbi([
  "function getAgent(bytes32 agentId) external view returns (bytes32 agentId, address agentAddress, bytes32 tenantId, bytes32 scopeHash, bytes32 behaviorHash, uint256 registeredAt, uint256 revokedAt)",
]);

interface CacheEntry {
  result: AgentAttestationResult;
  expiresAt: number;
}

const TTL_MS = 60_000;

export function makeAttestCounterpartyAgent(opts: {
  registryAddress: string;
  rpcUrl: string;
  chainId?: number;
}): (ctx: ServiceCallContext, input: AgentAttestationInput) => Promise<AgentAttestationResult> {
  const chain = opts.chainId === 8453 ? base : baseSepolia;
  const client = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  const cache = new Map<string, CacheEntry>();

  return async function attestCounterpartyAgent(
    _ctx: ServiceCallContext,
    input: AgentAttestationInput,
  ): Promise<AgentAttestationResult> {
    if (input.agentId === null) {
      return { attested: false, registered: false, reason: "agent_id_missing" };
    }

    const now = Date.now();
    const cached = cache.get(input.agentId);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.result;
    }

    let result: AgentAttestationResult;
    try {
      const reg = await client.readContract({
        address: opts.registryAddress as `0x${string}`,
        abi: REGISTRY_ABI,
        functionName: "getAgent",
        args: [input.agentId as `0x${string}`],
      });

      const [, , , , , registeredAt, revokedAt] = reg;

      if (registeredAt === 0n) {
        result = { attested: false, registered: false, reason: "agent_not_registered" };
      } else if (revokedAt !== 0n) {
        result = { attested: false, registered: true, paused: true, reason: "agent_paused" };
      } else {
        result = { attested: true, registered: true, paused: false };
      }
    } catch {
      result = { attested: false, registered: false, reason: "registry_read_failed" };
    }

    cache.set(input.agentId, { result, expiresAt: now + TTL_MS });
    return result;
  };
}
