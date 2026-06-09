import { describe, expect, it, vi, beforeEach } from "vitest";
import { BaseError, toHex } from "viem";

// Mock only the client factories — keep keccak256/toHex/toBytes/parseGwei and the
// error classes (BaseError/ContractFunctionRevertedError) real so the revert
// classifier behaves like production.
const writeContract = vi.fn();
const readContract = vi.fn();
const getContractEvents = vi.fn();
const estimateFeesPerGas = vi.fn();
const waitForTransactionReceipt = vi.fn();

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createWalletClient: () => ({ writeContract }),
    createPublicClient: () => ({
      readContract,
      getContractEvents,
      estimateFeesPerGas,
      waitForTransactionReceipt,
    }),
  };
});
vi.mock("viem/accounts", () => ({
  privateKeyToAccount: () => ({ address: "0x0000000000000000000000000000000000000001" }),
}));

import { createViemAnchorBroadcaster } from "./anchorBroadcaster.js";

const ROOT = Buffer.alloc(32, 0x11);
const rootHex = toHex(ROOT);
const TX = "0x" + "ab".repeat(32);

function makeBroadcaster() {
  return createViemAnchorBroadcaster({
    privateKey: ("0x" + "11".repeat(32)) as `0x${string}`,
    contractAddress: "0x00000000000000000000000000000000000000c0",
    rpcUrl: "http://rpc.test",
  });
}

const input = {
  tenantId: "tnt_x",
  merkleRoot: ROOT,
  eventCount: 3,
  periodStart: new Date("2026-06-09T00:00:00Z"),
  periodEnd: new Date("2026-06-09T01:00:00Z"),
};

describe("createViemAnchorBroadcaster", () => {
  beforeEach(() => {
    writeContract.mockReset();
    readContract.mockReset();
    getContractEvents.mockReset();
    estimateFeesPerGas.mockReset();
    waitForTransactionReceipt.mockReset();
    estimateFeesPerGas.mockResolvedValue({ maxPriorityFeePerGas: 0n, maxFeePerGas: 0n });
  });

  it("skips broadcast when the root is already published and returns the original tx", async () => {
    readContract.mockResolvedValue(true); // isPublished
    getContractEvents.mockResolvedValue([
      { args: { root: rootHex }, transactionHash: TX, blockNumber: 999n },
    ]);

    const res = await makeBroadcaster()(input);

    expect(res.status).toBe("already_anchored");
    expect(res.blockNumber).toBe(999n);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("returns confirmed for a tx mined with status=success", async () => {
    readContract.mockResolvedValue(false);
    writeContract.mockResolvedValue(TX);
    waitForTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: 123n });

    const res = await makeBroadcaster()(input);

    expect(res.status).toBe("confirmed");
    expect(res.blockNumber).toBe(123n);
    expect(res.txHash.toString("hex")).toBe("ab".repeat(32));
  });

  it("returns reverted for a tx mined with status=reverted (no phantom success)", async () => {
    readContract.mockResolvedValue(false);
    writeContract.mockResolvedValue(TX);
    waitForTransactionReceipt.mockResolvedValue({ status: "reverted", blockNumber: 5n });

    const res = await makeBroadcaster()(input);

    expect(res.status).toBe("reverted");
  });

  it("treats a deterministic send-time revert as terminal reverted", async () => {
    readContract.mockResolvedValueOnce(false); // pre-flight isPublished
    writeContract.mockRejectedValue(new BaseError("execution reverted"));
    readContract.mockResolvedValueOnce(false); // post-revert re-check: still not published

    const res = await makeBroadcaster()(input);

    expect(res.status).toBe("reverted");
  });

  it("heals to already_anchored when the root was published in the send-race window", async () => {
    readContract.mockResolvedValueOnce(false); // pre-flight
    writeContract.mockRejectedValue(new BaseError("execution reverted"));
    readContract.mockResolvedValueOnce(true); // re-check: now published
    getContractEvents.mockResolvedValue([
      { args: { root: rootHex }, transactionHash: TX, blockNumber: 7n },
    ]);

    const res = await makeBroadcaster()(input);

    expect(res.status).toBe("already_anchored");
    expect(res.blockNumber).toBe(7n);
  });

  it("rethrows a transient (non-revert) RPC error so the caller retries", async () => {
    readContract.mockResolvedValue(false);
    writeContract.mockRejectedValue(new Error("ECONNRESET"));

    await expect(makeBroadcaster()(input)).rejects.toThrow("ECONNRESET");
  });
});
