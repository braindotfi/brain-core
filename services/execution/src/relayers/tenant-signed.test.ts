import { describe, expect, it, vi, beforeEach } from "vitest";
import type * as Viem from "viem";
import { getAddress } from "viem";

const writeContract = vi.fn();
const estimateFeesPerGas = vi.fn();
const estimateContractGas = vi.fn();
const getBalance = vi.fn();
const waitForTransactionReceipt = vi.fn();
const signTypedData = vi.fn();

// Same dispatch-by-functionName pattern as kms-custodial.test.ts: the
// relayer makes three distinct readContract calls (isTenantSigner,
// signerNonce, getAgent), and each test should only have to control the
// ones it cares about.
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

// Deliberately has hex letters (unlike kms-custodial.test.ts's all-digit
// mock address) so its EIP-55 checksummed form actually differs in case --
// needed to exercise the case-insensitive comparison in the hard assert.
const BRAIN_ADDRESS = "0x0000000000000000000000000000000000abcdef";

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
    address: "0x0000000000000000000000000000000000abcdef",
    signTypedData,
  }),
}));

import {
  BrainSelfAttestationForbiddenError,
  TenantSignedRegistrationRelayer,
} from "./tenant-signed.js";
import { InsufficientRelayerFundsError } from "./registry-shared.js";

const REGISTRY = "0x00000000000000000000000000000000000c0c" as const;
const ZERO_HASH = "0x" + "00".repeat(32);
const REQUESTED_SCOPE_HASH = "cd".repeat(32);
const CUSTOMER_ADDRESS = "0xcccccccccccccccccccccccccccccccccccccc" as const;
const TENANT_SIGNATURE = "0xtenantsig";

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
  return new TenantSignedRegistrationRelayer({
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
    mode: "tenant_signed" as const,
    tenantSignerAddress: CUSTOMER_ADDRESS,
    tenantSignature: TENANT_SIGNATURE,
    ...overrides,
  };
}

describe("TenantSignedRegistrationRelayer", () => {
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
    // registered on-chain (phase 2 proceeds). Individual tests override one
    // or both to exercise the other branches.
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
    const relayer = new TenantSignedRegistrationRelayer({
      privateKey: undefined,
      rpcUrl: "http://rpc.test",
      registryAddress: REGISTRY,
    });
    expect(relayer.configured).toBe(false);
  });

  it("configured is false when the RPC URL is missing", () => {
    const relayer = new TenantSignedRegistrationRelayer({
      privateKey: ("0x" + "11".repeat(32)) as `0x${string}`,
      rpcUrl: undefined,
      registryAddress: REGISTRY,
    });
    expect(relayer.configured).toBe(false);
  });

  it("configured is false when the registry address is missing", () => {
    const relayer = new TenantSignedRegistrationRelayer({
      privateKey: ("0x" + "11".repeat(32)) as `0x${string}`,
      rpcUrl: "http://rpc.test",
      registryAddress: undefined,
    });
    expect(relayer.configured).toBe(false);
  });

  it("configured is true when signer, RPC, and registry are all present", () => {
    expect(makeRelayer().configured).toBe(true);
  });

  it("rejects mode=onchain_custodial", async () => {
    const relayer = makeRelayer();
    await expect(
      relayer.submitRegistration(baseRequest({ mode: "onchain_custodial" })),
    ).rejects.toThrow(/onchain_custodial/);
    expect(readContract).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });

  describe("the hard assert: Brain's own initialAdmin can never be the tenant signer", () => {
    it("throws BrainSelfAttestationForbiddenError and broadcasts nothing when tenantSignerAddress === Brain's address (lowercase)", async () => {
      const relayer = makeRelayer();
      await expect(
        relayer.submitRegistration(baseRequest({ tenantSignerAddress: BRAIN_ADDRESS })),
      ).rejects.toBeInstanceOf(BrainSelfAttestationForbiddenError);
      expect(writeContract).not.toHaveBeenCalled();
    });

    it("throws BrainSelfAttestationForbiddenError when tenantSignerAddress is the EIP-55 checksummed form of Brain's address", async () => {
      const checksummed = getAddress(BRAIN_ADDRESS);
      expect(checksummed).not.toBe(BRAIN_ADDRESS); // sanity: this address does mix case when checksummed
      const relayer = makeRelayer();
      await expect(
        relayer.submitRegistration(baseRequest({ tenantSignerAddress: checksummed })),
      ).rejects.toBeInstanceOf(BrainSelfAttestationForbiddenError);
      expect(writeContract).not.toHaveBeenCalled();
    });
  });

  describe("bootstrap phase (phase 1)", () => {
    it("is skipped when isTenantSigner already returns true for the customer address", async () => {
      isTenantSignerResult.mockResolvedValue(true);
      const relayer = makeRelayer();
      const result = await relayer.submitRegistration(baseRequest());

      expect(result.txHash).toBe("0xtxhash");
      expect(writeContract).toHaveBeenCalledTimes(1);
      expect(writeContract.mock.calls[0]?.[0]).toMatchObject({ functionName: "registerAgent" });
    });

    it("is performed when isTenantSigner returns false, seating the CUSTOMER address (not Brain's)", async () => {
      isTenantSignerResult.mockResolvedValue(false);
      signerNonceResult.mockResolvedValue(7n);
      const relayer = makeRelayer();
      const result = await relayer.submitRegistration(baseRequest());

      expect(result.txHash).toBe("0xtxhash");
      expect(writeContract).toHaveBeenCalledTimes(2);
      expect(writeContract.mock.calls[0]?.[0]).toMatchObject({ functionName: "setTenantSigner" });
      const setTenantSignerArgs = writeContract.mock.calls[0]?.[0]?.args as unknown[];
      expect(setTenantSignerArgs[1]).toBe(CUSTOMER_ADDRESS); // signer being seated
      expect(setTenantSignerArgs[1]).not.toBe(BRAIN_ADDRESS);
      expect(writeContract.mock.calls[1]?.[0]).toMatchObject({ functionName: "registerAgent" });
    });
  });

  it("phase 2 broadcasts registerAgent with the customer's designated address and the customer's own signature, never Brain's key", async () => {
    const relayer = makeRelayer();
    await relayer.submitRegistration(baseRequest());

    expect(writeContract).toHaveBeenCalledTimes(1);
    const registerAgentCall = writeContract.mock.calls[0]?.[0];
    expect(registerAgentCall).toMatchObject({ functionName: "registerAgent" });
    const args = registerAgentCall?.args as unknown[];
    expect(args[5]).toBe(CUSTOMER_ADDRESS); // authSigner
    expect(args[6]).toBe(TENANT_SIGNATURE); // tenantSignature
    // Phase 2 never invokes Brain's own signTypedData -- the signature is
    // already the customer's, collected out of band before confirmation.
    expect(signTypedData).not.toHaveBeenCalled();
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

  it("rejects a request missing tenantSignerAddress before any network call", async () => {
    const relayer = makeRelayer();
    await expect(
      relayer.submitRegistration(baseRequest({ tenantSignerAddress: undefined })),
    ).rejects.toThrow(/tenantSignerAddress/);
    expect(readContract).not.toHaveBeenCalled();
  });

  it("rejects a request missing tenantSignature before any network call", async () => {
    const relayer = makeRelayer();
    await expect(
      relayer.submitRegistration(baseRequest({ tenantSignature: undefined })),
    ).rejects.toThrow(/tenantSignature/);
    expect(readContract).not.toHaveBeenCalled();
  });

  describe("crashed-retry recovery (getAgent pre-check before phase 2), asserted through the tenant-signed entry point", () => {
    it("not registered: proceeds and broadcasts", async () => {
      const relayer = makeRelayer();
      const result = await relayer.submitRegistration(baseRequest());

      expect(result.txHash).toBe("0xtxhash");
      expect(writeContract).toHaveBeenCalledTimes(1);
      expect(writeContract.mock.calls[0]?.[0]).toMatchObject({ functionName: "registerAgent" });
    });

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
  });
});
