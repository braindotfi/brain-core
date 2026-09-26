import { brainError, withTenantScope } from "@brain/shared";
import type { ServiceCallContext } from "@brain/shared";
import type { OnchainDispatchParams } from "@brain/execution";
import type { Pool } from "pg";
import { createPublicClient, http, keccak256, parseAbi, toBytes } from "viem";
import { base, baseSepolia } from "viem/chains";
import { getHolderAddress } from "./onchainExecutor.js";
import { resolveOnchainTransferParams } from "./onchainTransferParams.js";

const TENANT_ACCOUNT_REGISTRY_ABI = parseAbi([
  "function accountOf(bytes32 tenantId) external view returns (address)",
]);
const BRAIN_SMART_ACCOUNT_ABI = parseAbi(["function tenantId() external view returns (bytes32)"]);
const BRAIN_SMART_ACCOUNT_AUTHORITY_ABI = parseAbi([
  "function owner() external view returns (address)",
  "function policyRegistry() external view returns (address)",
]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface TenantSmartAccountResolver {
  resolve(tenantId: string): Promise<string>;
}

export interface TenantOnchainAccountRecord {
  owner: string;
  policyRegistry: string;
}

export type TenantOnchainAccountRecordResolver = (
  tenantId: string,
) => Promise<TenantOnchainAccountRecord | null>;

export function tenantIdHash(tenantId: string): `0x${string}` {
  return keccak256(toBytes(tenantId));
}

function registryError(message: string, details?: Readonly<Record<string, unknown>>): Error {
  return brainError("execution_rail_misconfigured", message, {
    ...(details !== undefined ? { details } : {}),
  });
}

function dependencyError(message: string, cause: unknown): Error {
  return brainError("dependency_unavailable", message, { cause });
}

async function failClosedRpc<T>(op: () => Promise<T>, message: string): Promise<T> {
  try {
    return await op();
  } catch (err) {
    throw dependencyError(message, err);
  }
}

export function buildTenantSmartAccountResolver(opts: {
  registryAddress: string;
  expectedCodehash: string;
  rpcUrl: string;
  chainId?: number;
  resolveExpectedAccount: TenantOnchainAccountRecordResolver;
}): TenantSmartAccountResolver {
  const chain = opts.chainId === 8453 ? base : baseSepolia;
  const publicClient = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  const expectedCodehash = opts.expectedCodehash.toLowerCase();

  return {
    async resolve(tenantId: string): Promise<string> {
      const tenantHash = tenantIdHash(tenantId);
      const account = await failClosedRpc(
        () =>
          publicClient.readContract({
            address: opts.registryAddress as `0x${string}`,
            abi: TENANT_ACCOUNT_REGISTRY_ABI,
            functionName: "accountOf",
            args: [tenantHash],
          }),
        "tenant smart account registry read failed",
      );
      if (account.toLowerCase() === ZERO_ADDRESS) {
        throw registryError("tenant has no registered smart account");
      }

      const expected = await opts.resolveExpectedAccount(tenantId);
      if (expected === null) {
        throw registryError("tenant smart account onboarding record is missing");
      }

      const code = await failClosedRpc(
        () => publicClient.getCode({ address: account }),
        "registered smart account code read failed",
      );
      if (code === undefined || code === "0x") {
        throw registryError("registered smart account has no code");
      }
      const actualCodehash = keccak256(code).toLowerCase();
      if (actualCodehash !== expectedCodehash) {
        throw registryError("registered smart account codehash mismatch", {
          expected_codehash: expectedCodehash,
          actual_codehash: actualCodehash,
        });
      }

      const actualTenant = await failClosedRpc(
        () =>
          publicClient.readContract({
            address: account,
            abi: BRAIN_SMART_ACCOUNT_ABI,
            functionName: "tenantId",
          }),
        "registered smart account tenant read failed",
      );
      if (actualTenant.toLowerCase() !== tenantHash.toLowerCase()) {
        throw registryError("registered smart account tenant mismatch", {
          expected_tenant: tenantHash,
          actual_tenant: actualTenant,
        });
      }

      const [actualOwner, actualPolicyRegistry] = await failClosedRpc(
        () =>
          Promise.all([
            publicClient.readContract({
              address: account,
              abi: BRAIN_SMART_ACCOUNT_AUTHORITY_ABI,
              functionName: "owner",
            }),
            publicClient.readContract({
              address: account,
              abi: BRAIN_SMART_ACCOUNT_AUTHORITY_ABI,
              functionName: "policyRegistry",
            }),
          ]),
        "registered smart account authority read failed",
      );
      if (actualOwner.toLowerCase() !== expected.owner.toLowerCase()) {
        throw registryError("registered smart account owner mismatch", {
          expected_owner: expected.owner.toLowerCase(),
          actual_owner: actualOwner.toLowerCase(),
        });
      }
      if (actualPolicyRegistry.toLowerCase() !== expected.policyRegistry.toLowerCase()) {
        throw registryError("registered smart account policy registry mismatch", {
          expected_policy_registry: expected.policyRegistry.toLowerCase(),
          actual_policy_registry: actualPolicyRegistry.toLowerCase(),
        });
      }

      return account;
    },
  };
}

export function buildTenantOnchainAccountRecordResolver(
  pool: Pool,
): TenantOnchainAccountRecordResolver {
  return async (tenantId) =>
    withTenantScope(pool, tenantId, async (client) => {
      const { rows } = await client.query<{
        onchain_smart_account_owner: string | null;
        onchain_policy_registry_address: string | null;
      }>(
        `SELECT onchain_smart_account_owner, onchain_policy_registry_address
           FROM tenants
          WHERE id = $1
          LIMIT 1`,
        [tenantId],
      );
      const row = rows[0];
      if (
        row === undefined ||
        row.onchain_smart_account_owner === null ||
        row.onchain_policy_registry_address === null
      ) {
        return null;
      }
      return {
        owner: row.onchain_smart_account_owner,
        policyRegistry: row.onchain_policy_registry_address,
      };
    });
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
