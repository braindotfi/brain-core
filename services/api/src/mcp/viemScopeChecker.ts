import { createPublicClient, http, keccak256, toBytes } from "viem";
import { baseSepolia } from "viem/chains";

export interface OnchainScopeChecker {
  getOnchainScopeHash(agentId: string): Promise<string | null>;
}

export interface RegistrySelfCheckResult {
  ok: boolean;
  /** Present when `ok` is false: a one-line classification of the failure. */
  reason?: string;
}

/**
 * A scope checker that can also self-verify its registry binding at boot.
 * `createViemScopeChecker` returns this richer type; the `OnchainScopeChecker`
 * surface stays minimal so request-path consumers (and their test mocks) don't
 * have to know about `selfCheck`.
 */
export interface ViemScopeChecker extends OnchainScopeChecker {
  /**
   * Probe `getAgent` for a sentinel id and confirm the deployed registry's
   * `AgentRegistration` tuple decodes against this ABI. Unlike
   * `getOnchainScopeHash` (which fails closed to `null`), this surfaces the
   * underlying error so a stale/mis-set registry fails loudly at boot instead
   * of 401-ing every MCP call forever.
   */
  selfCheck(): Promise<RegistrySelfCheckResult>;
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

export function createViemScopeChecker(opts: ViemScopeCheckerOptions): ViemScopeChecker {
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(opts.rpcUrl),
  });

  return {
    async selfCheck(): Promise<RegistrySelfCheckResult> {
      // Sentinel id — almost certainly unregistered, which is fine: an
      // unregistered agent returns a zero-filled tuple, not an error. We only
      // care that getAgent *decodes* against this ABI. A stale/old-layout
      // registry (e.g. pre-`behaviorHash` 6-field) overruns the tuple and
      // throws, and a mis-set address (no contract) returns 0x and throws too.
      const sentinel = keccak256(toBytes("brain:mcp:registry:selfcheck")) as `0x${string}`;
      try {
        const registration = await client.readContract({
          address: opts.contractAddress,
          abi: BRAIN_MCP_AGENT_REGISTRY_ABI,
          functionName: "getAgent",
          args: [sentinel],
        });
        // Touch a decoded field so a layout skew is actually exercised.
        void registration.registeredAt;
        return { ok: true };
      } catch (err) {
        const name = err instanceof Error ? err.name : "UnknownError";
        const message = (err instanceof Error ? err.message : String(err)).split("\n")[0];
        // Distinguish a transient RPC fault from a genuine registry mismatch so
        // the caller can pick log severity. ABI/contract problems are the loud
        // ones — they will not self-heal.
        const transient = /Http|Timeout|Connection|fetch|network|socket/i.test(`${name} ${message}`);
        return { ok: false, reason: `${transient ? "rpc" : "registry"}: ${name}: ${message}` };
      }
    },
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
