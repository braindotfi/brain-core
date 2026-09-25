import { brainError } from "@brain/shared";
import type { ServiceCallContext } from "@brain/shared";
import type { OnchainDispatchParams } from "@brain/execution";
import { createPublicClient, http, keccak256, parseAbi, toBytes } from "viem";
import { base, baseSepolia } from "viem/chains";
import { getHolderAddress } from "./onchainExecutor.js";
import { resolveOnchainTransferParams } from "./onchainTransferParams.js";

const TENANT_ACCOUNT_REGISTRY_ABI = parseAbi([
  "function accountOf(bytes32 tenantId) external view returns (address)",
]);
const BRAIN_SMART_ACCOUNT_ABI = parseAbi(["function tenantId() external view returns (bytes32)"]);
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
        abi: TENANT_ACCOUNT_REGISTRY_ABI,
        functionName: "accountOf",
        args: [tenantHash],
      });
      if (account.toLowerCase() === ZERO_ADDRESS) {
        throw brainError("execution_rail_misconfigured", "tenant has no registered smart account");
      }

      const code = await publicClient.getCode({ address: account });
      if (code === undefined || code === "0x") {
        throw brainError("execution_rail_misconfigured", "registered smart account has no code");
      }
      const actualCodehash = keccak256(code).toLowerCase();
      if (actualCodehash !== expectedCodehash) {
        throw brainError(
          "execution_rail_misconfigured",
          "registered smart account codehash mismatch",
          {
            details: { expected_codehash: expectedCodehash, actual_codehash: actualCodehash },
          },
        );
      }

      const actualTenant = await publicClient.readContract({
        address: account,
        abi: BRAIN_SMART_ACCOUNT_ABI,
        functionName: "tenantId",
      });
      if (actualTenant.toLowerCase() !== tenantHash.toLowerCase()) {
        throw brainError(
          "execution_rail_misconfigured",
          "registered smart account tenant mismatch",
          {
            details: { expected_tenant: tenantHash, actual_tenant: actualTenant },
          },
        );
      }

      return account;
    },
  };
}

export interface TenantAwareOnchainParamsResolverOptions {
  sessionKey: `0x${string}`;
  tenantSmartAccountResolver?: TenantSmartAccountResolver;
  fallbackSmartAccount?: string;
  policyVersion: string;
  usdcAddress?: string;
  getUsdcDecimals?: (tokenAddress: string) => Promise<number>;
  findCounterpartyById: (
    ctx: ServiceCallContext,
    id: string,
  ) => Promise<{ onchain_address: string | null } | null>;
}

export function buildTenantAwareOnchainParamsResolver(
  opts: TenantAwareOnchainParamsResolverOptions,
): (
  ctx: ServiceCallContext,
  intent: {
    source_account_id: string;
    destination_counterparty_id: string;
    amount: string;
    currency: string;
  },
) => Promise<OnchainDispatchParams | null> {
  return async (ctx, intent) => {
    const cp = await opts.findCounterpartyById(ctx, intent.destination_counterparty_id);
    if (cp === null) return null;
    const resolvedSmartAccount =
      opts.tenantSmartAccountResolver !== undefined
        ? await opts.tenantSmartAccountResolver.resolve(ctx.tenantId)
        : opts.fallbackSmartAccount;
    if (resolvedSmartAccount === undefined) return null;
    return resolveOnchainTransferParams(cp, intent, {
      smartAccount: resolvedSmartAccount,
      holder: getHolderAddress(opts.sessionKey),
      policyVersion: opts.policyVersion,
      usdcAddress: opts.usdcAddress,
      getUsdcDecimals: opts.getUsdcDecimals,
    });
  };
}
