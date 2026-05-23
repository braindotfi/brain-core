import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { tenantIdToBytes32 } from "@brain/policy";

const BRAIN_POLICY_REGISTRY_ABI = [
  {
    name: "isTenantSigner",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tenantId", type: "bytes32" },
      { name: "a", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface ViemPolicySignerCheckerOptions {
  contractAddress: `0x${string}`;
  rpcUrl: string;
}

/**
 * Reads the on-chain BrainPolicyRegistry per-tenant signer allowlist
 * (`isTenantSigner`). The /policy/:tenant_id/sign route uses this to bind
 * off-chain quorum to pre-authorized signers. Fail-closed: any RPC/read error
 * resolves to `false` (not authorized), so a degraded chain connection can
 * never let an unauthorized signer count toward quorum.
 */
export function createViemPolicySignerChecker(
  opts: ViemPolicySignerCheckerOptions,
): (tenantId: string, address: string) => Promise<boolean> {
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(opts.rpcUrl),
  });

  return async (tenantId: string, address: string): Promise<boolean> => {
    try {
      return await client.readContract({
        address: opts.contractAddress,
        abi: BRAIN_POLICY_REGISTRY_ABI,
        functionName: "isTenantSigner",
        args: [tenantIdToBytes32(tenantId), address as `0x${string}`],
      });
    } catch {
      return false;
    }
  };
}
