/**
 * Unit tests for buildOnchainExecutor / getHolderAddress (fix/main-green).
 * viem is mocked so no RPC/chain is touched.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  readContract: vi.fn(),
  writeContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  privateKeyToAccount: vi.fn((_pk: string) => ({ address: "0xACCOUNT" })),
}));

vi.mock("viem", () => ({
  createPublicClient: vi.fn(() => ({
    readContract: m.readContract,
    waitForTransactionReceipt: m.waitForTransactionReceipt,
  })),
  createWalletClient: vi.fn(() => ({ writeContract: m.writeContract })),
  http: vi.fn(() => ({})),
  parseAbi: vi.fn((x: string[]) => x),
}));
vi.mock("viem/accounts", () => ({ privateKeyToAccount: m.privateKeyToAccount }));
vi.mock("viem/chains", () => ({ base: { id: 8453 }, baseSepolia: { id: 84_532 } }));

import { buildOnchainExecutor, getHolderAddress } from "./onchainExecutor.js";

const PK = ("0x" + "11".repeat(32)) as `0x${string}`;

describe("onchainExecutor", () => {
  beforeEach(() => {
    m.readContract.mockReset();
    m.writeContract.mockReset();
    m.waitForTransactionReceipt.mockReset();
  });

  it("getHolderAddress derives the session-key address", () => {
    expect(getHolderAddress(PK)).toBe("0xACCOUNT");
  });

  it("readNonce reads the smart-account nonce", async () => {
    m.readContract.mockResolvedValue(7n);
    const ex = buildOnchainExecutor({ privateKey: PK, rpcUrl: "http://rpc", chainId: 84_532 });
    expect(await ex.readNonce({ smartAccount: "0xSA", holder: "0xH" })).toBe(7n);
    expect(m.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "nonce", args: ["0xH"] }),
    );
  });

  it("execute writes the tx and maps the receipt", async () => {
    m.writeContract.mockResolvedValue("0xHASH");
    m.waitForTransactionReceipt.mockResolvedValue({
      transactionHash: "0xHASH",
      blockNumber: 99n,
      gasUsed: 21_000n,
    });
    const ex = buildOnchainExecutor({ privateKey: PK, rpcUrl: "http://rpc" }); // default baseSepolia
    const res = await ex.execute({
      smartAccount: "0xSA",
      holder: "0xH",
      nonce: 1n,
      target: "0xT",
      value: 0n,
      data: "0x",
    });
    expect(res).toEqual({ txHash: "0xHASH", blockNumber: 99n, gasUsed: 21_000n });
    expect(m.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "executeViaSessionKey" }),
    );
  });

  it("selects Base mainnet when chainId=8453", () => {
    expect(
      buildOnchainExecutor({ privateKey: PK, rpcUrl: "http://rpc", chainId: 8453 }),
    ).toBeDefined();
  });

  // ----- R-08: error-path coverage for the money-touching adapter ------

  it("readNonce propagates a viem read error verbatim (no silent fallback)", async () => {
    m.readContract.mockRejectedValue(new Error("ContractFunctionExecutionError: invalid abi"));
    const ex = buildOnchainExecutor({ privateKey: PK, rpcUrl: "http://rpc", chainId: 84_532 });
    await expect(ex.readNonce({ smartAccount: "0xSA", holder: "0xH" })).rejects.toThrow(
      /ContractFunctionExecutionError/,
    );
  });

  it("execute propagates a writeContract revert verbatim", async () => {
    m.writeContract.mockRejectedValue(new Error("execution reverted: ExceedsPerTxCap"));
    const ex = buildOnchainExecutor({ privateKey: PK, rpcUrl: "http://rpc", chainId: 84_532 });
    await expect(
      ex.execute({
        smartAccount: "0xSA",
        holder: "0xH",
        nonce: 1n,
        target: "0xT",
        value: 0n,
        data: "0x",
      }),
    ).rejects.toThrow(/ExceedsPerTxCap/);
    expect(m.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it("execute propagates a waitForTransactionReceipt timeout/error", async () => {
    m.writeContract.mockResolvedValue("0xHASH");
    m.waitForTransactionReceipt.mockRejectedValue(
      new Error("TimeoutError: tx not mined within 60s"),
    );
    const ex = buildOnchainExecutor({ privateKey: PK, rpcUrl: "http://rpc", chainId: 84_532 });
    await expect(
      ex.execute({
        smartAccount: "0xSA",
        holder: "0xH",
        nonce: 1n,
        target: "0xT",
        value: 0n,
        data: "0x",
      }),
    ).rejects.toThrow(/TimeoutError/);
  });

  it("execute passes value through unchanged to writeContract", async () => {
    m.writeContract.mockResolvedValue("0xHASH");
    m.waitForTransactionReceipt.mockResolvedValue({
      transactionHash: "0xHASH",
      blockNumber: 100n,
      gasUsed: 50_000n,
    });
    const ex = buildOnchainExecutor({ privateKey: PK, rpcUrl: "http://rpc", chainId: 84_532 });
    await ex.execute({
      smartAccount: "0xSA",
      holder: "0xH",
      nonce: 42n,
      target: "0xTARGET",
      value: 1_500_000_000_000_000_000n, // 1.5 ETH
      data: "0xdeadbeef",
    });
    expect(m.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [42n, "0xTARGET", 1_500_000_000_000_000_000n, "0xdeadbeef"],
      }),
    );
  });

  it("execute returns the receipt's actual hash even when it differs from the write hash", async () => {
    // viem typically returns the same hash, but the adapter should source the
    // canonical value from the receipt (the mined value), not the submission.
    m.writeContract.mockResolvedValue("0xSUBMIT");
    m.waitForTransactionReceipt.mockResolvedValue({
      transactionHash: "0xMINED",
      blockNumber: 99n,
      gasUsed: 21_000n,
    });
    const ex = buildOnchainExecutor({ privateKey: PK, rpcUrl: "http://rpc", chainId: 84_532 });
    const out = await ex.execute({
      smartAccount: "0xSA",
      holder: "0xH",
      nonce: 1n,
      target: "0xT",
      value: 0n,
      data: "0x",
    });
    expect(out.txHash).toBe("0xMINED");
  });
});
