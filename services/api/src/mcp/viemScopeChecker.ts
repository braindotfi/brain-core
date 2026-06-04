import { createPublicClient, http, keccak256, toBytes } from "viem";
import { baseSepolia } from "viem/chains";

export interface OnchainScopeChecker {
  getOnchainScopeHash(agentId: string): Promise<string | null>;
}

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
          // Must mirror the on-chain `AgentRegistration` struct order exactly:
          // `behaviorHash` sits BETWEEN `scopeHash` and `registeredAt`
          // (contracts/src/BrainMCPAgentRegistry.sol). viem decodes tuples
          // positionally, so omitting it shifts `registeredAt`/`revokedAt` onto
          // the wrong slots and makes every registered agent read as null.
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

export function createViemScopeChecker(opts: ViemScopeCheckerOptions): OnchainScopeChecker {
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(opts.rpcUrl),
  });

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
        if (registration.registeredAt === 0n || registration.revokedAt !== 0n) {
          return null;
        }
        return registration.scopeHash.slice(2).toLowerCase();
      } catch {
        // Fail closed (deny) instead of throwing. The decode can fail when the
        // deployed registry's AgentRegistration layout skews from this ABI —
        // e.g. a registry deployed BEFORE `behaviorHash` was added to the struct
        // (the field this ABI now includes) returns a 6-field tuple, and viem
        // overruns decoding it as 7. An unverifiable scope must never crash the
        // MCP auth path; treat it as "no on-chain scope".
        return null;
      }
    },
  };
}
