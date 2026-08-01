import { describe, expect, it, vi, beforeEach } from "vitest";
import { BaseError, encodeAbiParameters, encodeEventTopics, keccak256, toBytes, toHex } from "viem";
import type * as Viem from "viem";
import { MockMetrics } from "@brain/shared";

// Mock only the client factories — keep keccak256/toHex/toBytes/parseGwei and the
// error classes (BaseError/ContractFunctionRevertedError) real so the revert
// classifier behaves like production.
const writeContract = vi.fn();
const readContract = vi.fn();
const getContractEvents = vi.fn();
const estimateFeesPerGas = vi.fn();
const estimateContractGas = vi.fn();
const getBalance = vi.fn();
const getBlockNumber = vi.fn();
const waitForTransactionReceipt = vi.fn();

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof Viem>();
  return {
    ...actual,
    createWalletClient: () => ({ writeContract }),
    createPublicClient: () => ({
      readContract,
      getContractEvents,
      estimateFeesPerGas,
      estimateContractGas,
      getBalance,
      getBlockNumber,
      waitForTransactionReceipt,
    }),
  };
});
vi.mock("viem/accounts", () => ({
  privateKeyToAccount: () => ({ address: "0x0000000000000000000000000000000000000001" }),
}));

import {
  InsufficientAnchorFundsError,
  MAX_ANCHOR_BATCH_SIZE,
  createViemAnchorBroadcaster,
  findPublishedAnchorTxForTests,
  resolveAnchorScanFromBlock,
} from "./anchorBroadcaster.js";

const ROOT = Buffer.alloc(32, 0x11);
const rootHex = toHex(ROOT);
const TX = "0x" + "ab".repeat(32);
const CONTRACT = "0x00000000000000000000000000000000000000c0";

const ANCHOR_EVENT_ABI = [
  {
    name: "AnchorPublished",
    type: "event",
    inputs: [
      { name: "tenantId", type: "bytes32", indexed: true },
      { name: "root", type: "bytes32", indexed: false },
      { name: "eventCount", type: "uint256", indexed: false },
      { name: "periodStart", type: "uint256", indexed: false },
      { name: "periodEnd", type: "uint256", indexed: false },
    ],
  },
] as const;

function makeBroadcaster() {
  return createViemAnchorBroadcaster({
    privateKey: ("0x" + "11".repeat(32)) as `0x${string}`,
    contractAddress: CONTRACT,
    rpcUrl: "http://rpc.test",
    fromBlock: 100n,
  });
}

function anchorPublishedLog(input: {
  tenantId: string;
  merkleRoot: Buffer;
  eventCount: number;
  periodStart: Date;
  periodEnd: Date;
}) {
  const tenantId = keccak256(toBytes(input.tenantId));
  return {
    address: CONTRACT,
    topics: encodeEventTopics({
      abi: ANCHOR_EVENT_ABI,
      eventName: "AnchorPublished",
      args: { tenantId },
    }),
    data: encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [
        toHex(input.merkleRoot),
        BigInt(input.eventCount),
        BigInt(Math.floor(input.periodStart.getTime() / 1000)),
        BigInt(Math.floor(input.periodEnd.getTime() / 1000)),
      ],
    ),
  };
}

const input = {
  tenantId: "tnt_x",
  merkleRoot: ROOT,
  eventCount: 3,
  periodStart: new Date("2026-06-09T00:00:00Z"),
  periodEnd: new Date("2026-06-09T01:00:00Z"),
};

const inputB = {
  tenantId: "tnt_y",
  merkleRoot: Buffer.alloc(32, 0x22),
  eventCount: 4,
  periodStart: new Date("2026-06-09T02:00:00Z"),
  periodEnd: new Date("2026-06-09T03:00:00Z"),
};

describe("createViemAnchorBroadcaster", () => {
  beforeEach(() => {
    writeContract.mockReset();
    readContract.mockReset();
    getContractEvents.mockReset();
    estimateFeesPerGas.mockReset();
    estimateContractGas.mockReset();
    getBalance.mockReset();
    getBlockNumber.mockReset();
    waitForTransactionReceipt.mockReset();
    estimateFeesPerGas.mockResolvedValue({ maxPriorityFeePerGas: 0n, maxFeePerGas: 0n });
    estimateContractGas.mockResolvedValue(100_000n);
    getBalance.mockResolvedValue(1_000_000_000_000_000_000n);
    getBlockNumber.mockResolvedValue(10_000n);
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

  it("throws InsufficientAnchorFundsError and spends no nonce when the publisher wallet cannot afford gas", async () => {
    const metrics = new MockMetrics();
    readContract.mockResolvedValue(false);
    estimateFeesPerGas.mockResolvedValue({
      maxPriorityFeePerGas: 1_000_000_000n,
      maxFeePerGas: 2_000_000_000n,
    });
    estimateContractGas.mockResolvedValue(100_000n);
    getBalance.mockResolvedValue(100_000_000_000_000n);
    const broadcaster = createViemAnchorBroadcaster({
      privateKey: ("0x" + "11".repeat(32)) as `0x${string}`,
      contractAddress: CONTRACT,
      rpcUrl: "http://rpc.test",
      gasSafetyFactor: 2,
      metrics,
      walletBalanceAlertWei: 500_000_000_000_000n,
      fromBlock: 100n,
    });

    await expect(broadcaster(input)).rejects.toBeInstanceOf(InsufficientAnchorFundsError);

    expect(writeContract).not.toHaveBeenCalled();
    expect(metrics.calls).toContainEqual(
      expect.objectContaining({
        kind: "gauge",
        name: "brain.audit.anchor.publisher_wallet_balance_wei",
        value: 100_000_000_000_000,
      }),
    );
    expect(metrics.calls).toContainEqual(
      expect.objectContaining({
        kind: "increment",
        name: "brain.audit.anchor.publisher_wallet_insufficient_funds.count",
        tags: { severity: "critical" },
      }),
    );
  });

  it("proceeds normally when the publisher wallet can afford the guarded gas budget", async () => {
    const metrics = new MockMetrics();
    readContract.mockResolvedValue(false);
    estimateFeesPerGas.mockResolvedValue({
      maxPriorityFeePerGas: 1_000_000_000n,
      maxFeePerGas: 2_000_000_000n,
    });
    estimateContractGas.mockResolvedValue(100_000n);
    getBalance.mockResolvedValue(1_000_000_000_000_000_000n);
    writeContract.mockResolvedValue(TX);
    waitForTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: 123n });
    const broadcaster = createViemAnchorBroadcaster({
      privateKey: ("0x" + "11".repeat(32)) as `0x${string}`,
      contractAddress: CONTRACT,
      rpcUrl: "http://rpc.test",
      gasSafetyFactor: 2,
      metrics,
      fromBlock: 100n,
    });

    const res = await broadcaster(input);

    expect(res.status).toBe("confirmed");
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(metrics.calls).toContainEqual(
      expect.objectContaining({
        kind: "gauge",
        name: "brain.audit.anchor.publisher_wallet_balance_wei",
      }),
    );
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

  it("batch prefilters already-published roots and broadcasts the rest once", async () => {
    readContract
      .mockResolvedValueOnce(true) // input A already published
      .mockResolvedValueOnce(false); // input B needs anchorBatch
    getContractEvents.mockResolvedValue([
      { args: { root: rootHex }, transactionHash: TX, blockNumber: 999n },
    ]);
    writeContract.mockResolvedValue("0x" + "cd".repeat(32));
    waitForTransactionReceipt.mockResolvedValue({
      status: "success",
      blockNumber: 123n,
      logs: [anchorPublishedLog(inputB)],
    });

    const res = await makeBroadcaster().broadcastAnchorBatch([input, inputB]);

    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "anchorBatch" }),
    );
    expect(res.map((row) => row.result.status)).toEqual(["already_anchored", "confirmed"]);
    expect(res[0]?.result.blockNumber).toBe(999n);
    expect(res[1]?.result.txHash.toString("hex")).toBe("cd".repeat(32));
  });

  it("batch throws InsufficientAnchorFundsError and spends no nonce when under budget", async () => {
    readContract.mockResolvedValue(false);
    estimateFeesPerGas.mockResolvedValue({
      maxPriorityFeePerGas: 1_000_000_000n,
      maxFeePerGas: 2_000_000_000n,
    });
    estimateContractGas.mockResolvedValue(500_000n);
    getBalance.mockResolvedValue(100_000_000_000_000n);
    const broadcaster = createViemAnchorBroadcaster({
      privateKey: ("0x" + "11".repeat(32)) as `0x${string}`,
      contractAddress: CONTRACT,
      rpcUrl: "http://rpc.test",
      gasSafetyFactor: 2,
      fromBlock: 100n,
    });

    await expect(broadcaster.broadcastAnchorBatch([input, inputB])).rejects.toBeInstanceOf(
      InsufficientAnchorFundsError,
    );

    expect(writeContract).not.toHaveBeenCalled();
  });

  it("batch returns reverted per row for a mined reverted batch tx", async () => {
    readContract.mockResolvedValue(false);
    writeContract.mockResolvedValue(TX);
    waitForTransactionReceipt.mockResolvedValue({ status: "reverted", blockNumber: 123n });

    const res = await makeBroadcaster().broadcastAnchorBatch([input, inputB]);

    expect(res).toHaveLength(2);
    expect(res.every((row) => row.result.status === "reverted")).toBe(true);
    expect(res.every((row) => row.result.txHash.length === 0)).toBe(true);
  });

  it("batch treats success without a matching AnchorPublished event as already anchored", async () => {
    readContract.mockResolvedValue(false);
    writeContract.mockResolvedValue(TX);
    waitForTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: 123n, logs: [] });
    getContractEvents.mockResolvedValue([
      { args: { root: rootHex }, transactionHash: TX, blockNumber: 122n },
      { args: { root: toHex(inputB.merkleRoot) }, transactionHash: TX, blockNumber: 122n },
    ]);

    const res = await makeBroadcaster().broadcastAnchorBatch([input, inputB]);

    expect(res.map((row) => row.result.status)).toEqual(["already_anchored", "already_anchored"]);
  });

  it("batch rejects caller batches above the configured contract cap", async () => {
    const broadcaster = makeBroadcaster();
    const tooMany = Array.from({ length: MAX_ANCHOR_BATCH_SIZE + 1 }, () => input);

    await expect(broadcaster.broadcastAnchorBatch(tooMany)).rejects.toThrow(
      "exceeds configured maximum",
    );

    expect(readContract).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });
});

describe("resolveAnchorScanFromBlock", () => {
  it("uses the configured deploy block when provided", () => {
    expect(
      resolveAnchorScanFromBlock({
        configuredFromBlock: 1234n,
        latestBlock: 9999n,
        lookbackBlocks: 500n,
        nodeEnv: "production",
      }),
    ).toBe(1234n);
  });

  it("uses a non-genesis windowed floor in production when no deploy block is configured", () => {
    expect(
      resolveAnchorScanFromBlock({
        latestBlock: 10_000n,
        lookbackBlocks: 2_000n,
        nodeEnv: "production",
      }),
    ).toBe(8_000n);
    expect(
      resolveAnchorScanFromBlock({
        latestBlock: 500n,
        lookbackBlocks: 2_000n,
        nodeEnv: "production",
      }),
    ).toBe(1n);
  });
});

describe("findPublishedAnchorTxForTests", () => {
  it("scans bounded block chunks and locates an event even when wide ranges fail", async () => {
    getBlockNumber.mockResolvedValue(6_000n);
    getContractEvents.mockImplementation(
      async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        if (toBlock - fromBlock + 1n > 2_000n) {
          throw new Error("block range too wide");
        }
        if (fromBlock === 4_001n) {
          return [{ args: { root: rootHex }, transactionHash: TX, blockNumber: 4_500n }];
        }
        return [];
      },
    );
    const publicClient = {
      getBlockNumber,
      getContractEvents,
    } as never;

    const res = await findPublishedAnchorTxForTests({
      publicClient,
      contractAddress: CONTRACT,
      tenantIdBytes: ("0x" + "12".repeat(32)) as `0x${string}`,
      rootHexLower: rootHex.toLowerCase(),
      fromBlock: 1n,
      maxBlockSpan: 2_000,
    });

    expect(res?.blockNumber).toBe(4_500n);
    expect(getContractEvents).toHaveBeenCalledTimes(3);
  });
});
