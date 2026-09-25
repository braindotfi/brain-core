import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Viem from "viem";

const m = vi.hoisted(() => ({
  readContract: vi.fn(),
  getCode: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof Viem>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      readContract: m.readContract,
      getCode: m.getCode,
    })),
    http: vi.fn(() => ({})),
  };
});

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: vi.fn(() => ({ address: "0x6666666666666666666666666666666666666666" })),
}));

import { keccak256 } from "viem";
import type { ServiceCallContext } from "@brain/shared";
import {
  buildTenantAwareOnchainParamsResolver,
  buildTenantSmartAccountResolver,
  tenantIdHash,
} from "./tenantAccountRegistry.js";

const REGISTRY = "0x1111111111111111111111111111111111111111";
const ACTIVE_ACCOUNT = "0x2222222222222222222222222222222222222222";
const PENDING_ACCOUNT = "0x3333333333333333333333333333333333333333";
const FALLBACK_ACCOUNT = "0x4444444444444444444444444444444444444444";
const PAYEE = "0x5555555555555555555555555555555555555555";
const HOLDER = "0x6666666666666666666666666666666666666666";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SMART_ACCOUNT_CODE = "0x60016001";
const EXPECTED_CODEHASH = keccak256(SMART_ACCOUNT_CODE);
const SESSION_KEY = `0x${"11".repeat(32)}` as `0x${string}`;
const POLICY_VERSION = `0x${"22".repeat(32)}`;
const TENANT_ID = "tenant_test";
const CTX: ServiceCallContext = {
  tenantId: TENANT_ID,
  actor: "agent_test",
  requestId: "req_test",
};

function resolver() {
  return buildTenantSmartAccountResolver({
    registryAddress: REGISTRY,
    expectedCodehash: EXPECTED_CODEHASH,
    rpcUrl: "http://rpc",
    chainId: 84_532,
  });
}

describe("buildTenantSmartAccountResolver", () => {
  beforeEach(() => {
    m.readContract.mockReset();
    m.getCode.mockReset();
    m.getCode.mockResolvedValue(SMART_ACCOUNT_CODE);
  });

  it("rejects a codehash mismatch", async () => {
    m.readContract.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "accountOf") return ACTIVE_ACCOUNT;
      return tenantIdHash(TENANT_ID);
    });
    const accountResolver = buildTenantSmartAccountResolver({
      registryAddress: REGISTRY,
      expectedCodehash: `0x${"00".repeat(32)}`,
      rpcUrl: "http://rpc",
      chainId: 84_532,
    });

    await expect(accountResolver.resolve(TENANT_ID)).rejects.toMatchObject({
      code: "execution_rail_misconfigured",
      message: "registered smart account codehash mismatch",
    });
  });

  it("rejects a tenantId mismatch", async () => {
    m.readContract.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "accountOf") return ACTIVE_ACCOUNT;
      return tenantIdHash("other_tenant");
    });

    await expect(resolver().resolve(TENANT_ID)).rejects.toMatchObject({
      code: "execution_rail_misconfigured",
      message: "registered smart account tenant mismatch",
    });
  });

  it("does not use a pending replacement before activation", async () => {
    m.readContract.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "accountOf") return ACTIVE_ACCOUNT;
      return tenantIdHash(TENANT_ID);
    });

    await expect(resolver().resolve(TENANT_ID)).resolves.toBe(ACTIVE_ACCOUNT);
    expect(m.getCode).toHaveBeenCalledWith({ address: ACTIVE_ACCOUNT });
    expect(m.getCode).not.toHaveBeenCalledWith({ address: PENDING_ACCOUNT });
  });

  it("fails closed when the tenant has no registry entry", async () => {
    m.readContract.mockResolvedValue(ZERO_ADDRESS);

    await expect(resolver().resolve(TENANT_ID)).rejects.toMatchObject({
      code: "execution_rail_misconfigured",
      message: "tenant has no registered smart account",
    });
    expect(m.getCode).not.toHaveBeenCalled();
  });
});

describe("buildTenantAwareOnchainParamsResolver", () => {
  it("uses the registry-resolved account instead of the legacy fallback", async () => {
    const resolve = vi.fn(async () => ACTIVE_ACCOUNT);
    const findCounterpartyById = vi.fn(async () => ({ onchain_address: PAYEE }));
    const paramsResolver = buildTenantAwareOnchainParamsResolver({
      sessionKey: SESSION_KEY,
      tenantSmartAccountResolver: { resolve },
      fallbackSmartAccount: FALLBACK_ACCOUNT,
      policyVersion: POLICY_VERSION,
      findCounterpartyById,
    });

    const params = await paramsResolver(CTX, {
      source_account_id: "acct_test",
      destination_counterparty_id: "cp_test",
      amount: "1",
      currency: "ETH",
    });

    expect(resolve).toHaveBeenCalledWith(TENANT_ID);
    expect(findCounterpartyById).toHaveBeenCalledWith(CTX, "cp_test");
    expect(params).toMatchObject({
      smart_account: ACTIVE_ACCOUNT,
      holder: HOLDER,
      target: PAYEE,
      value: "1000000000000000000",
      policy_version: POLICY_VERSION,
    });
  });
});
