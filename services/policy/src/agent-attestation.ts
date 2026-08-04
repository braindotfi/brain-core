/**
 * Gate check 5.5 — agent-counterparty attestation loader (RFC 0001 §6.3).
 *
 * PRODUCT DECISION: check 5.5 verifies the payee agent is genuinely
 * registered in `BrainMCPAgentRegistry` and not revoked — full stop. It does
 * NOT require the agent to have been registered by the tenant that is paying
 * it. `_agents` is a GLOBAL namespace in the registry, and that is exactly
 * what makes cross-org M2M/x402 payments (tenant A paying tenant B's
 * registered agent) the canonical case this rail exists for
 * (docs/v0.4-open-ecosystem-interop.md §7). Gating on `isAuthorized`'s
 * same-tenant equality would hard-reject that case. Read via `getAgent` only.
 *
 * Injected into PaymentIntentService at boot; the gate
 * (shared/src/gate/gate.ts:495) hard-rejects an unregistered or revoked agent
 * payee when this loader is present.
 *
 * 60-second in-memory TTL cache keyed by agentId alone: the verdict here does
 * not depend on the calling tenant, so a tenant-qualified key would only
 * fragment the cache (one entry per (tenant, agent) pair instead of one per
 * agent) without changing correctness. An agent revocation propagates within
 * one cache TTL.
 */

import { createPublicClient, http, keccak256, parseAbi, toBytes } from "viem";
import { baseSepolia, base } from "viem/chains";
import type {
  AgentAttestationInput,
  AgentAttestationResult,
  ServiceCallContext,
} from "@brain/shared";

const REGISTRY_ABI = parseAbi([
  "function getAgent(bytes32 agentId) external view returns ((bytes32 agentId, address agentAddress, bytes32 tenantId, bytes32 scopeHash, bytes32 behaviorHash, uint256 registeredAt, uint256 revokedAt))",
]);

/**
 * On-chain agent id: `keccak256(bytes(agent_id))`, matching
 * `scripts/ops/register-prod-agent.ts` and `viemScopeChecker.ts`. `agentId`
 * here is the ULID stored in `ledger_counterparties.agent_id`
 * (`^agent_[0-9A-HJKMNP-TV-Z]{26}$`), never a hex value, so it must be hashed
 * before it reaches calldata the same way registration hashed it.
 */
function onchainAgentId(agentId: string): `0x${string}` {
  return keccak256(toBytes(agentId));
}

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
    // Cache key is the agent id alone (see header). The decision does not
    // vary by calling tenant, so a tenant-qualified key would be dead weight.
    const cacheKey = input.agentId;
    const cached = cache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.result;
    }

    let result: AgentAttestationResult;
    try {
      const agentId = onchainAgentId(input.agentId);
      const reg = await client.readContract({
        address: opts.registryAddress as `0x${string}`,
        abi: REGISTRY_ABI,
        functionName: "getAgent",
        args: [agentId],
      });

      if (reg.registeredAt === 0n) {
        result = { attested: false, registered: false, reason: "agent_not_registered" };
      } else if (reg.revokedAt !== 0n) {
        // Revocation is TERMINAL in the registry: there is no unpause and the
        // agentId can never be re-registered. Reporting it as "paused" sent
        // operators looking for a switch that does not exist.
        result = { attested: false, registered: true, revoked: true, reason: "agent_revoked" };
      } else {
        result = { attested: true, registered: true, revoked: false };
      }
    } catch {
      result = { attested: false, registered: false, reason: "registry_read_failed" };
    }

    cache.set(cacheKey, { result, expiresAt: now + TTL_MS });
    return result;
  };
}
