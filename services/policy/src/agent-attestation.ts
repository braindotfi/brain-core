/**
 * Gate check 5.5 — agent-counterparty attestation loader (RFC 0001 §6.3).
 *
 * Authorization is `BrainMCPAgentRegistry.isAuthorized(agentId, tenantId)`,
 * read via viem. Injected into PaymentIntentService at boot; the gate
 * (shared/src/gate/gate.ts:495) hard-rejects an unregistered or revoked agent
 * payee when this loader is present.
 *
 * The TENANT BINDING is the point. `_agents` is a GLOBAL namespace in the
 * registry, so an agent registered by tenant A must not satisfy an
 * authorization check made on behalf of tenant B. This loader previously read
 * `getAgent` and discarded the `tenantId` it returned, which made check 5.5
 * cross-tenant. `getAgent` is still read, but only to tell "never registered"
 * apart from "revoked" for the audit reason.
 *
 * 60-second in-memory TTL cache keyed by (tenantId, agentId) — mirrors the MCP
 * auth check in services/api/src/auth/siwx.ts. An agent revocation propagates
 * within one cache TTL.
 */

import { createPublicClient, http, keccak256, parseAbi, toBytes, toHex } from "viem";
import { baseSepolia, base } from "viem/chains";
import type {
  AgentAttestationInput,
  AgentAttestationResult,
  ServiceCallContext,
} from "@brain/shared";

const REGISTRY_ABI = parseAbi([
  "function getAgent(bytes32 agentId) external view returns ((bytes32 agentId, address agentAddress, bytes32 tenantId, bytes32 scopeHash, bytes32 behaviorHash, uint256 registeredAt, uint256 revokedAt))",
  "function isAuthorized(bytes32 agentId, bytes32 tenantId) external view returns (bool)",
]);

/**
 * On-chain tenant id: `keccak256(bytes(tenant_id))`, matching how the deploy
 * scripts derive it (`keccak256(bytes(vm.envString("BRAIN_TENANT_ID")))`).
 */
function onchainTenantId(tenantId: string): `0x${string}` {
  return keccak256(toHex(tenantId));
}

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
    // Cache key includes the tenant: the same agentId can be authorized for one
    // tenant and not another, so a tenant-blind key would leak the first
    // caller's verdict to every other tenant for a full TTL.
    const cacheKey = `${input.tenantId}:${input.agentId}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.result;
    }

    let result: AgentAttestationResult;
    try {
      const agentId = onchainAgentId(input.agentId);
      const tenantId = onchainTenantId(input.tenantId);

      // The authorization decision. Registered AND not revoked AND belonging to
      // THIS tenant, all enforced on-chain in one call.
      const authorized = await client.readContract({
        address: opts.registryAddress as `0x${string}`,
        abi: REGISTRY_ABI,
        functionName: "isAuthorized",
        args: [agentId, tenantId],
      });

      if (authorized) {
        result = { attested: true, registered: true, revoked: false };
      } else {
        // Not authorized. Read the record only to give the audit trail a
        // precise reason; this never widens the decision above.
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
          result = {
            attested: false,
            registered: true,
            revoked: false,
            reason: "agent_tenant_mismatch",
          };
        }
      }
    } catch {
      result = { attested: false, registered: false, reason: "registry_read_failed" };
    }

    cache.set(cacheKey, { result, expiresAt: now + TTL_MS });
    return result;
  };
}
