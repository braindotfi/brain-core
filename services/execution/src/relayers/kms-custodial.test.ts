import { describe, expect, it, vi, beforeEach } from "vitest";
import type * as Viem from "viem";

const writeContract = vi.fn();
const estimateFeesPerGas = vi.fn();
const estimateContractGas = vi.fn();
const getBalance = vi.fn();
const waitForTransactionReceipt = vi.fn();
const signTypedData = vi.fn();

// The relayer makes three distinct readContract calls (isTenantSigner,
// signerNonce, getAgent). Dispatching on functionName -- rather than a bare
// vi.fn() with a queued sequence of mockResolvedValueOnce -- lets each test
// control only the calls it cares about without having to also thread a
// getAgent response through every phase-1-focused test.
const isTenantSignerResult = vi.fn();
const signerNonceResult = vi.fn();
const getAgentResult = vi.fn();
const readContract = vi.fn(async (args: { functionName: string }) => {
  switch (args.functionName) {
    case "isTenantSigner":
      return isTenantSignerResult();
    case "signerNonce":
      return signerNonceResult();
    case "getAgent":
      return getAgentResult();
    default:
      throw new Error("unexpected readContract call: " + args.functionName);
  }
});

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof Viem>();
  return {
    ...actual,
    createWalletClient: () => ({ writeContract }),
    createPublicClient: () => ({
      readContract,
      estimateFeesPerGas,
      estimateContractGas,
      getBalance,
      waitForTransactionReceipt,
    }),
  };
});
vi.mock("viem/accounts", () => ({
  privateKeyToAccount: () => ({
    address: "0x0000000000000000000000000000000000000001",
    signTypedData,
  }),
}));

import { InsufficientRelayerFundsError, KmsCustodialRegistrationRelayer } from "./kms-custodial.js";

const REGISTRY = "0x00000000000000000000000000000000000c0c" as const;
const ZERO_HASH = "0x" + "00".repeat(32);
const REQUESTED_SCOPE_HASH = "cd".repeat(32);

const NOT_REGISTERED = {
  agentId: ZERO_HASH,
  agentAddress: "0x0000000000000000000000000000000000000000",
  tenantId: ZERO_HASH,
  scopeHash: ZERO_HASH,
  behaviorHash: ZERO_HASH,
  registeredAt: 0n,
  revokedAt: 0n,
};

function makeRelayer() {
  return new KmsCustodialRegistrationRelayer({
    privateKey: ("0x" + "11".repeat(32)) as `0x${string}`,
    rpcUrl: "http://rpc.test",
    registryAddress: REGISTRY,
  });
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent_x",
    tenantId: "tnt_x",
    onchainAddress: "0x" + "ab".repeat(20),
    scopeHash: REQUESTED_SCOPE_HASH,
    mode: "onchain_custodial" as const,
    ...overrides,
  };
}

describe("KmsCustodialRegistrationRelayer", () => {
  beforeEach(() => {
    writeContract.mockReset();
    readContract.mockClear();
    isTenantSignerResult.mockReset();
    signerNonceResult.mockReset();
    getAgentResult.mockReset();
    estimateFeesPerGas.mockReset();
    estimateContractGas.mockReset();
    getBalance.mockReset();
    waitForTransactionReceipt.mockReset();
    signTypedData.mockReset();

    // Default: signer already seated (phase 1 skipped), agent not yet
    // registered on-chain (phase 2 proceeds as before). Individual tests
    // override one or both to exercise the other branches.
    isTenantSignerResult.mockResolvedValue(true);
    getAgentResult.mockResolvedValue(NOT_REGISTERED);
    estimateFeesPerGas.mockResolvedValue({ maxPriorityFeePerGas: 0n, maxFeePerGas: 0n });
    estimateContractGas.mockResolvedValue(100_000n);
    getBalance.mockResolvedValue(1_000_000_000_000_000_000n);
    signTypedData.mockResolvedValue("0xsig");
    writeContract.mockResolvedValue("0xtxhash");
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
  });

  it("configured is false when the signer key is missing", () => {
    const relayer = new KmsCustodialRegistrationRelayer({
      privateKey: undefined,
      rpcUrl: "http://rpc.test",
      registryAddress: REGISTRY,
    });
    expect(relayer.configured).toBe(false);
  });

  it("configured is false when the RPC URL is missing", () => {
    const relayer = new KmsCustodialRegistrationRelayer({
      privateKey: ("0x" + "11".repeat(32)) as `0x${string}`,
      rpcUrl: undefined,
      registryAddress: REGISTRY,
    });
    expect(relayer.configured).toBe(false);
  });

  it("configured is false when the registry address is missing", () => {
    const relayer = new KmsCustodialRegistrationRelayer({
      privateKey: ("0x" + "11".repeat(32)) as `0x${string}`,
      rpcUrl: "http://rpc.test",
      registryAddress: undefined,
    });
    expect(relayer.configured).toBe(false);
  });

  it("configured is true when signer, RPC, and registry are all present", () => {
    expect(makeRelayer().configured).toBe(true);
  });

  it("rejects submitRegistration when unconfigured", async () => {
    const relayer = new KmsCustodialRegistrationRelayer({
      privateKey: undefined,
      rpcUrl: undefined,
      registryAddress: undefined,
    });
    await expect(relayer.submitRegistration(baseRequest())).rejects.toThrow(/not configured/i);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("rejects mode=tenant_signed", async () => {
    const relayer = makeRelayer();
    await expect(
      relayer.submitRegistration(baseRequest({ mode: "tenant_signed" })),
    ).rejects.toThrow(/tenant_signed/);
    expect(readContract).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("skips phase 1 (setTenantSigner) when the signer is already seated", async () => {
    const relayer = makeRelayer();
    const result = await relayer.submitRegistration(baseRequest());

    expect(result.txHash).toBe("0xtxhash");
    expect(result.alreadyRegistered).toBeUndefined();
    // Only phase 2 (registerAgent) broadcasts.
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract.mock.calls[0]?.[0]).toMatchObject({ functionName: "registerAgent" });
  });

  it("runs phase 1 then phase 2 when the signer is not yet seated", async () => {
    isTenantSignerResult.mockResolvedValue(false);
    signerNonceResult.mockResolvedValue(7n);
    const relayer = makeRelayer();
    const result = await relayer.submitRegistration(baseRequest());

    expect(result.txHash).toBe("0xtxhash");
    expect(writeContract).toHaveBeenCalledTimes(2);
    expect(writeContract.mock.calls[0]?.[0]).toMatchObject({ functionName: "setTenantSigner" });
    expect(writeContract.mock.calls[1]?.[0]).toMatchObject({ functionName: "registerAgent" });
  });

  it("throws and does not promote when registerAgent mines a revert", async () => {
    waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    const relayer = makeRelayer();

    await expect(relayer.submitRegistration(baseRequest())).rejects.toThrow(/reverted/);
  });

  it("throws InsufficientRelayerFundsError before writeContract when the wallet balance is too low", async () => {
    getBalance.mockResolvedValue(1n); // far below gas * fee
    const relayer = makeRelayer();

    await expect(relayer.submitRegistration(baseRequest())).rejects.toBeInstanceOf(
      InsufficientRelayerFundsError,
    );
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("rejects a zero onchain address before any network call", async () => {
    const relayer = makeRelayer();
    await expect(
      relayer.submitRegistration(
        baseRequest({ onchainAddress: "0x0000000000000000000000000000000000000000" }),
      ),
    ).rejects.toThrow(/onchain_address/);
    expect(readContract).not.toHaveBeenCalled();
  });

  describe("crashed-retry recovery (getAgent pre-check before phase 2)", () => {
    it("already-registered with a MATCHING scopeHash: no phase-2 broadcast, resolves with a null txHash", async () => {
      getAgentResult.mockResolvedValue({
        ...NOT_REGISTERED,
        scopeHash: "0x" + REQUESTED_SCOPE_HASH,
        registeredAt: 1_700_000_000n,
        revokedAt: 0n,
      });
      const relayer = makeRelayer();
      const result = await relayer.submitRegistration(baseRequest());

      expect(result).toEqual({ txHash: null, alreadyRegistered: true });
      expect(writeContract).not.toHaveBeenCalled();
    });

    it("already-registered with a DIFFERENT scopeHash: throws, does not broadcast", async () => {
      getAgentResult.mockResolvedValue({
        ...NOT_REGISTERED,
        scopeHash: "0x" + "ef".repeat(32),
        registeredAt: 1_700_000_000n,
        revokedAt: 0n,
      });
      const relayer = makeRelayer();

      await expect(relayer.submitRegistration(baseRequest())).rejects.toThrow(/differs|different/i);
      expect(writeContract).not.toHaveBeenCalled();
    });

    it("already-registered but revoked: throws, does not broadcast", async () => {
      getAgentResult.mockResolvedValue({
        ...NOT_REGISTERED,
        scopeHash: "0x" + REQUESTED_SCOPE_HASH,
        registeredAt: 1_700_000_000n,
        revokedAt: 1_700_000_500n,
      });
      const relayer = makeRelayer();

      await expect(relayer.submitRegistration(baseRequest())).rejects.toThrow(/revoked/i);
      expect(writeContract).not.toHaveBeenCalled();
    });

    it("not registered: broadcasts exactly as before", async () => {
      const relayer = makeRelayer();
      const result = await relayer.submitRegistration(baseRequest());

      expect(result.txHash).toBe("0xtxhash");
      expect(writeContract).toHaveBeenCalledTimes(1);
      expect(writeContract.mock.calls[0]?.[0]).toMatchObject({ functionName: "registerAgent" });
    });
  });
});
