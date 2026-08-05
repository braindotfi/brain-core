/**
 * Unit tests for buildX402Client (F1/F2 regression: x402 must route through
 * the injected OnchainExecutor / BrainSmartAccount.executeViaSessionKey
 * rather than a bare session-key EOA transfer).
 *
 * The x402 settle path has three steps:
 *   1. Read USDC.decimals() and encode transfer(payTo, amountUnits)
 *   2. executor.readNonce + executor.execute (BrainSmartAccount.executeViaSessionKey)
 *   3. POST to facilitator URL (best-effort; non-fatal)
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { OnchainExecutor } from "@brain/execution";

import { buildX402Client } from "./x402Client.js";

const USDC = "0xUSDC" as `0x${string}`;
const SMART_ACCOUNT = "0xSMARTACCOUNT";
const HOLDER = "0xHOLDER";

function makeExecutor(): {
  executor: OnchainExecutor;
  readNonce: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
} {
  const readNonce = vi.fn();
  const execute = vi.fn();
  return { executor: { readNonce, execute }, readNonce, execute };
}

function makeClient(over: Partial<Parameters<typeof buildX402Client>[0]> = {}) {
  const { executor } = over.executor !== undefined ? { executor: over.executor } : makeExecutor();
  return buildX402Client({
    facilitatorUrl: "https://facilitator.test/settle",
    usdcAddress: USDC,
    network: "base-sepolia",
    executor,
    smartAccount: SMART_ACCOUNT,
    holderAddress: HOLDER,
    getUsdcDecimals: vi.fn().mockResolvedValue(6),
    ...over,
  });
}

let fetchSpy: MockInstance<
  (
    input: string | URL | Request,
    init?: (Parameters<typeof fetch>[1] & object) | undefined,
  ) => Promise<Response>
>;
const realFetch = global.fetch;

describe("buildX402Client.settle", () => {
  beforeEach(() => {
    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    global.fetch = realFetch;
  });

  it("F1: routes settlement through executeViaSessionKey, not a bare transfer", async () => {
    const { executor, readNonce, execute } = makeExecutor();
    readNonce.mockResolvedValue(3n);
    execute.mockResolvedValue({ txHash: "0xTXMINED", blockNumber: 100n, gasUsed: 50_000n });
    const getUsdcDecimals = vi.fn().mockResolvedValue(6);
    const client = makeClient({ executor, getUsdcDecimals });

    const out = await client.settle({
      payTo: "0x19732c2b2656017fc00f5af5dcc33269e58a1d34",
      amount: "12.34",
      idempotencyKey: "ik_1",
    });

    expect(out.txHash).toBe("0xTXMINED");
    expect(out.settledAmount).toBe("12.34");
    expect(getUsdcDecimals).toHaveBeenCalledWith(USDC);
    expect(readNonce).toHaveBeenCalledWith({ smartAccount: SMART_ACCOUNT, holder: HOLDER });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        smartAccount: SMART_ACCOUNT,
        holder: HOLDER,
        nonce: 3n,
        target: USDC, // the USDC contract, not the payee -- transfer() is calldata
        value: 0n,
        // a9059cbb = transfer(address,uint256) selector; the payee + amount
        // are encoded in the calldata, not sent as a native-value transfer.
        data: expect.stringMatching(/^0xa9059cbb/),
      }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://facilitator.test/settle",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("encodes the payee address and amount into the calldata, not the value/target", async () => {
    const { executor, readNonce, execute } = makeExecutor();
    readNonce.mockResolvedValue(0n);
    execute.mockResolvedValue({ txHash: "0xTX", blockNumber: 1n, gasUsed: 1n });
    const payee = "0xe3abc18b2718c20882e8a0d2142623c897de3544";
    const client = makeClient({ executor });
    await client.settle({ payTo: payee, amount: "1.00", idempotencyKey: "ik_2" });
    const call = execute.mock.calls[0]![0] as { target: string; value: bigint; data: string };
    expect(call.target).toBe(USDC); // the call targets the token, not the payee
    expect(call.value).toBe(0n); // no native value; the transfer is in calldata
    expect(call.data.toLowerCase()).toContain(payee.slice(2).toLowerCase().padStart(64, "0"));
    // amount 1.00 USDC at 6 decimals = 1_000_000 = 0xf4240, right-padded to 32 bytes
    expect(call.data.toLowerCase().endsWith("f4240")).toBe(true);
  });

  it("decimals read failure throws (execute never runs)", async () => {
    const { executor, execute } = makeExecutor();
    const getUsdcDecimals = vi.fn().mockRejectedValue(new Error("RpcError: getCode reverted"));
    const client = makeClient({ executor, getUsdcDecimals });
    await expect(
      client.settle({
        payTo: "0x19732c2b2656017fc00f5af5dcc33269e58a1d34",
        amount: "1.00",
        idempotencyKey: "ik_3",
      }),
    ).rejects.toThrow(/RpcError/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("F2: a reverted execute() throws (propagated from the shared executor); facilitator not notified", async () => {
    const { executor, readNonce, execute } = makeExecutor();
    readNonce.mockResolvedValue(0n);
    execute.mockRejectedValue(new Error("executeViaSessionKey reverted (tx 0xDEAD)"));
    const client = makeClient({ executor });
    await expect(
      client.settle({
        payTo: "0x19732c2b2656017fc00f5af5dcc33269e58a1d34",
        amount: "1.00",
        idempotencyKey: "ik_4",
      }),
    ).rejects.toThrow(/reverted/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("facilitator 5xx is non-fatal: settle still resolves with the on-chain result", async () => {
    const { executor, readNonce, execute } = makeExecutor();
    readNonce.mockResolvedValue(0n);
    execute.mockResolvedValue({ txHash: "0xCONFIRMED", blockNumber: 1n, gasUsed: 1n });
    fetchSpy.mockResolvedValue(new Response("upstream down", { status: 503 }));
    const client = makeClient({ executor });
    const out = await client.settle({
      payTo: "0x19732c2b2656017fc00f5af5dcc33269e58a1d34",
      amount: "1.00",
      idempotencyKey: "ik_5",
    });
    expect(out.txHash).toBe("0xCONFIRMED");
    expect(out.settledAmount).toBe("1.00");
  });

  it("facilitator network error is non-fatal: settle still resolves", async () => {
    const { executor, readNonce, execute } = makeExecutor();
    readNonce.mockResolvedValue(0n);
    execute.mockResolvedValue({ txHash: "0xCONFIRMED", blockNumber: 1n, gasUsed: 1n });
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const client = makeClient({ executor });
    const out = await client.settle({
      payTo: "0x19732c2b2656017fc00f5af5dcc33269e58a1d34",
      amount: "1.00",
      idempotencyKey: "ik_6",
    });
    expect(out.txHash).toBe("0xCONFIRMED");
  });

  it("forwards idempotency_key and asset to the facilitator body", async () => {
    const { executor, readNonce, execute } = makeExecutor();
    readNonce.mockResolvedValue(0n);
    execute.mockResolvedValue({ txHash: "0xCONFIRMED", blockNumber: 1n, gasUsed: 1n });
    const client = makeClient({ executor });
    await client.settle({
      payTo: "0x19732c2b2656017fc00f5af5dcc33269e58a1d34",
      amount: "1.00",
      idempotencyKey: "ik_unique_xyz",
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as Parameters<typeof fetch>[1] & object).body as string,
    );
    expect(body.idempotency_key).toBe("ik_unique_xyz");
    expect(body.tx_hash).toBe("0xCONFIRMED");
    expect(body.pay_to).toBe("0x19732c2b2656017fc00f5af5dcc33269e58a1d34");
    expect(body.amount).toBe("1.00");
    expect(body.asset).toBe("USDC");
    expect(body.network).toBe("base-sepolia");
  });
});
