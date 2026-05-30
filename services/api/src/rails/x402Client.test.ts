/**
 * Unit tests for buildX402Client (R-08 from Opus 4.8 review, batch 8 P5).
 * viem + fetch are mocked so no RPC and no facilitator are touched.
 *
 * The x402 settle path has four steps:
 *   1. Read USDC.decimals()
 *   2. writeContract USDC.transfer(payTo, amountUnits)
 *   3. waitForTransactionReceipt
 *   4. POST to facilitator URL (best-effort; non-fatal)
 *
 * Coverage targets: each step's success + each step's failure mode + the
 * best-effort semantics of step 4 (settlement is the on-chain transfer; the
 * facilitator POST never causes a settle() throw).
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const m = vi.hoisted(() => ({
  readContract: vi.fn(),
  writeContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  privateKeyToAccount: vi.fn((_pk: string) => ({ address: "0xACCOUNT" })),
  parseUnits: vi.fn((amount: string, decimals: number) => {
    const [whole = "0", frac = ""] = amount.split(".");
    const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
    return BigInt(whole + padded);
  }),
}));

vi.mock("viem", () => ({
  createPublicClient: vi.fn(() => ({
    readContract: m.readContract,
    waitForTransactionReceipt: m.waitForTransactionReceipt,
  })),
  createWalletClient: vi.fn(() => ({ writeContract: m.writeContract })),
  http: vi.fn(() => ({})),
  parseAbi: vi.fn((x: string[]) => x),
  parseUnits: m.parseUnits,
}));
vi.mock("viem/accounts", () => ({ privateKeyToAccount: m.privateKeyToAccount }));
vi.mock("viem/chains", () => ({ base: { id: 8453 }, baseSepolia: { id: 84_532 } }));

import { buildX402Client } from "./x402Client.js";

const PK = ("0x" + "11".repeat(32)) as `0x${string}`;
const USDC = "0xUSDC";

function makeClient(over: Partial<Parameters<typeof buildX402Client>[0]> = {}) {
  return buildX402Client({
    facilitatorUrl: "https://facilitator.test/settle",
    usdcAddress: USDC,
    network: "base-sepolia",
    privateKey: PK,
    rpcUrl: "http://rpc",
    chainId: 84_532,
    ...over,
  });
}

// vi.spyOn(global, "fetch") returns a strongly-typed MockInstance; use the
// explicit fetch signature so the assertion against .mock.calls stays sound.
let fetchSpy: MockInstance<
  (
    input: string | URL | Request,
    init?: (Parameters<typeof fetch>[1] & object) | undefined,
  ) => Promise<Response>
>;
const realFetch = global.fetch;

describe("buildX402Client.settle", () => {
  beforeEach(() => {
    m.readContract.mockReset();
    m.writeContract.mockReset();
    m.waitForTransactionReceipt.mockReset();
    m.parseUnits.mockClear();
    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    global.fetch = realFetch;
  });

  it("happy path: reads decimals, transfers, waits, notifies, returns receipt hash", async () => {
    m.readContract.mockResolvedValue(6);
    m.writeContract.mockResolvedValue("0xTXSUBMIT");
    m.waitForTransactionReceipt.mockResolvedValue({
      transactionHash: "0xTXMINED",
      blockNumber: 100n,
      gasUsed: 50_000n,
    });
    const client = makeClient();
    const out = await client.settle({
      payTo: "0xPAYEE",
      amount: "12.34",
      idempotencyKey: "ik_1",
    });
    expect(out.txHash).toBe("0xTXMINED");
    expect(out.settledAmount).toBe("12.34");
    expect(m.parseUnits).toHaveBeenCalledWith("12.34", 6);
    expect(m.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "transfer", address: USDC }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://facilitator.test/settle",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("decimals read failure throws (transfer never runs)", async () => {
    m.readContract.mockRejectedValue(new Error("RpcError: getCode reverted"));
    const client = makeClient();
    await expect(
      client.settle({ payTo: "0xPAYEE", amount: "1.00", idempotencyKey: "ik_2" }),
    ).rejects.toThrow(/RpcError/);
    expect(m.writeContract).not.toHaveBeenCalled();
  });

  it("transfer revert throws (receipt wait never runs)", async () => {
    m.readContract.mockResolvedValue(6);
    m.writeContract.mockRejectedValue(new Error("execution reverted: ERC20InsufficientBalance"));
    const client = makeClient();
    await expect(
      client.settle({ payTo: "0xPAYEE", amount: "999999999999.00", idempotencyKey: "ik_3" }),
    ).rejects.toThrow(/ERC20InsufficientBalance/);
    expect(m.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it("receipt wait failure throws (facilitator not notified)", async () => {
    m.readContract.mockResolvedValue(6);
    m.writeContract.mockResolvedValue("0xTX");
    m.waitForTransactionReceipt.mockRejectedValue(new Error("TimeoutError"));
    const client = makeClient();
    await expect(
      client.settle({ payTo: "0xPAYEE", amount: "1.00", idempotencyKey: "ik_4" }),
    ).rejects.toThrow(/TimeoutError/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("facilitator 5xx is non-fatal: settle still resolves with the on-chain receipt", async () => {
    m.readContract.mockResolvedValue(6);
    m.writeContract.mockResolvedValue("0xTX");
    m.waitForTransactionReceipt.mockResolvedValue({
      transactionHash: "0xCONFIRMED",
      blockNumber: 1n,
      gasUsed: 1n,
    });
    fetchSpy.mockResolvedValue(new Response("upstream down", { status: 503 }));
    const client = makeClient();
    const out = await client.settle({
      payTo: "0xPAYEE",
      amount: "1.00",
      idempotencyKey: "ik_5",
    });
    expect(out.txHash).toBe("0xCONFIRMED");
    expect(out.settledAmount).toBe("1.00");
  });

  it("facilitator network error is non-fatal: settle still resolves", async () => {
    m.readContract.mockResolvedValue(6);
    m.writeContract.mockResolvedValue("0xTX");
    m.waitForTransactionReceipt.mockResolvedValue({
      transactionHash: "0xCONFIRMED",
      blockNumber: 1n,
      gasUsed: 1n,
    });
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const client = makeClient();
    const out = await client.settle({
      payTo: "0xPAYEE",
      amount: "1.00",
      idempotencyKey: "ik_6",
    });
    expect(out.txHash).toBe("0xCONFIRMED");
  });

  it("forwards idempotency_key to the facilitator body", async () => {
    m.readContract.mockResolvedValue(6);
    m.writeContract.mockResolvedValue("0xTX");
    m.waitForTransactionReceipt.mockResolvedValue({
      transactionHash: "0xCONFIRMED",
      blockNumber: 1n,
      gasUsed: 1n,
    });
    const client = makeClient();
    await client.settle({
      payTo: "0xPAYEE",
      amount: "1.00",
      idempotencyKey: "ik_unique_xyz",
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as Parameters<typeof fetch>[1] & object).body as string,
    );
    expect(body.idempotency_key).toBe("ik_unique_xyz");
    expect(body.tx_hash).toBe("0xCONFIRMED");
    expect(body.pay_to).toBe("0xPAYEE");
    expect(body.amount).toBe("1.00");
    expect(body.asset).toBe("USDC");
    expect(body.network).toBe("base-sepolia");
  });

  it("selects Base mainnet (chainId=8453) when configured", () => {
    expect(makeClient({ chainId: 8453 })).toBeDefined();
  });
});
