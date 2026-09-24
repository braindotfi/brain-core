import { brainError } from "@brain/shared";
import { createPublicClient, http, keccak256, parseAbi, toBytes } from "viem";
import { base, baseSepolia } from "viem/chains";

const REGISTRY_ABI = parseAbi(["function accountOf(bytes32 tenantId) external view returns (address)"]);
const SMART_ACCOUNT_ABI = parseAbi(["function tenantId() external view returns (bytes32)"]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface TenantSmartAccountResolver {
  resolve(tenantId: string): Promise<string>;
}

export function tenantIdHash(tenantId: string): `0x${string}` {
  return keccak256(toBytes(tenantId));
}

export function buildTenantSmartAccountResolver(opts: {
  registryAddress: string;
  expectedCodehash: string;
  rpcUrl: string;
  chainId?: number;
}): TenantSmartAccountResolver {
  const chain = opts.chainId === 8453 ? base : baseSepolia;
  const publicClient = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  const expectedCodehash = opts.expectedCodehash.toLowerCase();

  return {
    async resolve(tenantId: string): Promise<string> {
      const tenantHash = tenantIdHash(tenantId);
      const account = await publicClient.readContract({
        address: opts.registryAddress as `0x${string}`,
        abi: REGISTRY_ABI,
        functionName: "accountOf",
        args: [tenantHash],
      });
      if (account.toLowerCase() === ZERO_ADDRESS) {
        throw brainError("onchain_account_unassigned", "tenant has no registered smart account");
      }

      const code = await publicClient.getCode({ address: account });
      if (code === undefined || code === "0x") {
        throw brainError("onchain_account_invalid", "registered smart account has no code");
      }
      const actualCodehash = keccak256(code).toLowerCase();
      if (actualCodehash !== expectedCodehash) {
        throw brainError("onchain_account_invalid", "registered smart account codehash mismatch", {
          details: { expected_codehash: expectedCodehash, actual_codehash: actualCodehash },
        });
      }

      const actualTenant = await publicClient.readContract({
        address: account,
        abi: SMART_ACCOUNT_ABI,
        functionName: "tenantId",
      });
      if (actualTenant.toLowerCase() !== tenantHash.toLowerCase()) {
        throw brainError("onchain_account_invalid", "registered smart account tenant mismatch", {
          details: { expected_tenant: tenantHash, actual_tenant: actualTenant },
        });
      }

      return account;
    },
  };
}
