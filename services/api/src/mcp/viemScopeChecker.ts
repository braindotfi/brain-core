import { createPublicClient, http, keccak256, toBytes } from "viem";
import { baseSepolia } from "viem/chains";
import type { OnchainScopeChecker } from "@brain/mcp";

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

export function createViemScopeChecker(opts: ViemScopeCheckerOptions): OnchainScopeChecker {
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(opts.rpcUrl),
  });

  return {
    async getOnchainScopeHash(agentId: string): Promise<string | null> {
      const agentIdBytes = keccak256(toBytes(agentId)) as `0x${string}`;

      const registration = await client.readContract({
        address: opts.contractAddress,
        abi: BRAIN_MCP_AGENT_REGISTRY_ABI,
        functionName: "getAgent",
        args: [agentIdBytes],
      });

      if (registration.registeredAt === 0n || registration.revokedAt !== 0n) {
        return null;
      }

      return registration.scopeHash.slice(2).toLowerCase();
    },
  };
}
