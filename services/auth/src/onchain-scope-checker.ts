/**
 * A minimal `OnchainScopeChecker` (services/mcp/src/auth.ts) reading
 * BrainMCPAgentRegistry directly. This is a deliberate partial duplicate of
 * services/api/src/mcp/viemScopeChecker.ts's `getOnchainScopeHash` --
 * services/api is not importable here (Runtime isolation, CLAUDE.md; its
 * package.json "exports" only declares ".", which pulls in the whole API
 * boot, the same reason security-headers.ts does not reuse @brain/api's).
 *
 * ponytail: no `selfCheck()` boot probe here, unlike the API's richer
 * version -- that is a nice-to-have loud-failure diagnostic, not something
 * `assertScopeHashAcceptable` (the only consumer in this service) needs. Add
 * it if a stale `MCP_AGENT_REGISTRY_ADDRESS` on this service turns out hard
 * to diagnose in practice.
 */

import { createPublicClient, http, keccak256, toBytes } from "viem";
import { baseSepolia } from "viem/chains";
import { OnchainScopeUnavailableError, type OnchainScopeChecker } from "@brain/mcp";

const BRAIN_MCP_AGENT_REGISTRY_ABI = [
  {
    name: "getAgent",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "agentId", type: "bytes32" },
          { name: "agentAddress", type: "address" },
          { name: "tenantId", type: "bytes32" },
          { name: "scopeHash", type: "bytes32" },
          // Order must mirror the on-chain AgentRegistration struct exactly --
          // see viemScopeChecker.ts's identical comment.
          { name: "behaviorHash", type: "bytes32" },
          { name: "registeredAt", type: "uint256" },
          { name: "revokedAt", type: "uint256" },
        ],
      },
    ],
  },
] as const;

export interface ViemScopeCheckerOptions {
  contractAddress: `0x${string}`;
  rpcUrl: string;
}

export function createAuthOnchainScopeChecker(opts: ViemScopeCheckerOptions): OnchainScopeChecker {
  const client = createPublicClient({ chain: baseSepolia, transport: http(opts.rpcUrl) });

  return {
    async getOnchainScopeHash(agentId: string): Promise<string | null> {
      const agentIdBytes = keccak256(toBytes(agentId)) as `0x${string}`;
      try {
        const registration = await client.readContract({
          address: opts.contractAddress,
          abi: BRAIN_MCP_AGENT_REGISTRY_ABI,
          functionName: "getAgent",
          args: [agentIdBytes],
        });
        if (registration.registeredAt === 0n || registration.revokedAt !== 0n) return null;
        return registration.scopeHash.slice(2).toLowerCase();
      } catch (err) {
        // Throw rather than fail closed to null -- identical reasoning to
        // viemScopeChecker.ts. Collapsing an RPC/decode fault to null let a
        // chain outage silently read as "agent has no on-chain scope",
        // which the consent and token routes then treated identically to a
        // genuinely unregistered agent instead of an unverifiable one.
        const name = err instanceof Error ? err.name : "UnknownError";
        const message = (err instanceof Error ? err.message : String(err)).split("\n")[0];
        const transient = /Http|Timeout|Connection|fetch|network|socket/i.test(
          `${name} ${message}`,
        );
        throw new OnchainScopeUnavailableError(
          `${transient ? "rpc" : "registry"}: ${name}: ${message}`,
        );
      }
    },
  };
}
