/**
 * X402BaseRail tests (v0.4 / RFC 0001 §7.3).
 *
 * The live x402 facilitator / viem USDC transfer is the deferred "live wiring"
 * step (mirrors the ach-plaid / onchain-base rails). These exercise the rail
 * logic against a mock X402Client: the happy settle, action validation
 * (USDC-on-Base only, decimal amount, 0x payee), idempotency-key threading, and
 * the declined path.
 */

import { describe, expect, it, vi } from "vitest";
import { BrainError } from "@brain/shared";
import {
  X402BaseRail,
  type X402Client,
  type X402SettleArgs,
  type X402SettleResult,
} from "./x402-base.js";
import type { RailDispatchInput } from "./types.js";

const PAY_TO = "0x" + "be".repeat(20);
const TX_HASH = "0x" + "cd".repeat(32);

function dispatchInput(overrides: Partial<RailDispatchInput> = {}): RailDispatchInput {
  return {
    tenantId: "tnt_1",
    proposalId: "prop_1",
    executionId: "exec_1",
    idempotencyKey: "pi:pi_1:dec_1",
    action: { asset: "USDC", network: "base", amount: "100.00", pay_to: PAY_TO },
    ...overrides,
  };
}

function mockClient(impl?: (args: X402SettleArgs) => Promise<X402SettleResult>): {
  client: X402Client;
  calls: X402SettleArgs[];
} {
  const calls: X402SettleArgs[] = [];
  const client: X402Client = {
    settle: vi.fn(async (args: X402SettleArgs) => {
      calls.push(args);
      if (impl) return impl(args);
      return { txHash: TX_HASH, settledAmount: args.amount };
    }),
  };
  return { client, calls };
}

describe("X402BaseRail.dispatch", () => {
  it("settles a USDC-on-Base payment and returns an x402 receipt", async () => {
    const { client, calls } = mockClient();
    const { receipt } = await new X402BaseRail({ client }).dispatch(dispatchInput());

    expect(receipt).toMatchObject({
      rail: "x402",
      asset: "USDC",
      network: "base",
      tx_hash: TX_HASH,
      settled_amount: "100.00",
      pay_to: PAY_TO,
    });
    // idempotency key is threaded to the client (exactly-once settle).
    expect(calls[0]!.idempotencyKey).toBe("pi:pi_1:dec_1");
  });

  it("rejects a non-USDC asset", async () => {
    const { client } = mockClient();
    await expect(
      new X402BaseRail({ client }).dispatch(
        dispatchInput({ action: { asset: "DAI", network: "base", amount: "1", pay_to: PAY_TO } }),
      ),
    ).rejects.toBeInstanceOf(BrainError);
  });

  it("rejects a non-Base network", async () => {
    const { client } = mockClient();
    await expect(
      new X402BaseRail({ client }).dispatch(
        dispatchInput({
          action: { asset: "USDC", network: "ethereum", amount: "1", pay_to: PAY_TO },
        }),
      ),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("rejects a non-decimal amount", async () => {
    const { client } = mockClient();
    await expect(
      new X402BaseRail({ client }).dispatch(
        dispatchInput({
          action: { asset: "USDC", network: "base", amount: "lots", pay_to: PAY_TO },
        }),
      ),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("rejects a malformed pay_to address", async () => {
    const { client } = mockClient();
    await expect(
      new X402BaseRail({ client }).dispatch(
        dispatchInput({ action: { asset: "USDC", network: "base", amount: "1", pay_to: "alice" } }),
      ),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("maps a client failure to execution_rail_declined", async () => {
    const { client } = mockClient(async () => {
      throw new Error("facilitator timeout");
    });
    await expect(new X402BaseRail({ client }).dispatch(dispatchInput())).rejects.toMatchObject({
      code: "execution_rail_declined",
    });
  });
});
