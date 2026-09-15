import { describe, expect, it } from "vitest";
import type { Principal } from "@brain/shared";
import {
  assertX402SellerCredentialEligible,
  executeX402UpfrontSettlement,
  settleBeforeFulfillment,
  X402_BASE_SEPOLIA_NETWORK,
  X402_BASE_SEPOLIA_USDC,
  type CoinbaseExactFacilitator,
  type X402V2ExactRequirements,
} from "./x402-seller-protocol.js";

const requirements: X402V2ExactRequirements = {
  x402Version: 2,
  scheme: "exact",
  network: X402_BASE_SEPOLIA_NETWORK,
  asset: X402_BASE_SEPOLIA_USDC,
  amount: "10000",
  payTo: "0x1111111111111111111111111111111111111111",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

describe("x402 seller protocol", () => {
  it("settles and requires sealed L2 finality before invoking fulfillment", async () => {
    const order: string[] = [];
    const result = await settleBeforeFulfillment({
      facilitator: {
        verify: async () => {
          order.push("verify");
          return { valid: true, payer: "0xpayer", reason: null };
        },
        settle: async () => {
          order.push("settle");
          return {
            success: true,
            payer: "0xpayer",
            transaction: `0x${"a".repeat(64)}`,
            network: X402_BASE_SEPOLIA_NETWORK,
            errorReason: null,
          };
        },
      },
      finality: {
        requireRpcConfirmation: async () => {
          order.push("rpc");
        },
        requireSealed: async () => {
          order.push("sealed");
        },
      },
      requirements,
      paymentPayload: { signature: "redacted" },
      fulfill: async () => {
        order.push("fulfill");
        return "ok";
      },
    });

    expect(order).toEqual(["verify", "settle", "rpc", "sealed", "fulfill"]);
    expect(result.result).toBe("ok");
  });

  it("never invokes fulfillment after verification, settlement, or finality failure", async () => {
    let fulfilled = false;
    await expect(
      settleBeforeFulfillment({
        facilitator: {
          verify: async () => ({ valid: true, payer: "0xpayer", reason: null }),
          settle: async () => ({
            success: false,
            payer: "0xpayer",
            transaction: null,
            network: X402_BASE_SEPOLIA_NETWORK,
            errorReason: "settlement_pending",
          }),
        },
        finality: {
          requireRpcConfirmation: async () => undefined,
          requireSealed: async () => undefined,
        },
        requirements,
        paymentPayload: {},
        fulfill: async () => {
          fulfilled = true;
        },
      }),
    ).rejects.toThrow(/settlement_pending/);
    expect(fulfilled).toBe(false);
  });

  it("rejects failed verification and mismatched settlement networks", async () => {
    const facilitator: CoinbaseExactFacilitator = {
      verify: async () => ({ valid: false, payer: null, reason: null }),
      settle: async () => ({
        success: true,
        payer: "0xpayer",
        transaction: `0x${"a".repeat(64)}`,
        network: "eip155:1",
        errorReason: null,
      }),
    };
    const fulfill = async () => "unexpected";

    await expect(
      settleBeforeFulfillment({
        facilitator,
        finality: {
          requireRpcConfirmation: async () => undefined,
          requireSealed: async () => undefined,
        },
        requirements,
        paymentPayload: {},
        fulfill,
      }),
    ).rejects.toThrow(/verification failed: unknown/);

    facilitator.verify = async () => ({ valid: true, payer: "0xpayer", reason: null });
    await expect(
      settleBeforeFulfillment({
        facilitator,
        finality: {
          requireRpcConfirmation: async () => undefined,
          requireSealed: async () => undefined,
        },
        requirements,
        paymentPayload: {},
        fulfill,
      }),
    ).rejects.toThrow(/network does not match/);
  });

  it("accepts the Coinbase Base Sepolia network alias", async () => {
    const result = await settleBeforeFulfillment({
      facilitator: {
        verify: async () => ({ valid: true, payer: "0xpayer", reason: null }),
        settle: async () => ({
          success: true,
          payer: "0xpayer",
          transaction: `0x${"b".repeat(64)}`,
          network: "base-sepolia",
          errorReason: null,
        }),
      },
      finality: {
        requireRpcConfirmation: async () => undefined,
        requireSealed: async () => undefined,
      },
      requirements,
      paymentPayload: {},
      fulfill: async () => "ok",
    });
    expect(result.result).toBe("ok");
  });

  it("explicitly excludes direct and exchanged brain_ak credentials", () => {
    expect(() =>
      assertX402SellerCredentialEligible({ presentedCredential: "brain_ak_live_redacted" }),
    ).toThrow(/never eligible/);

    const agent: Principal = {
      id: "agent_01M2B3C4D5E6F7G8H9JKMNPQRS",
      type: "agent",
      tenantId: "tnt_01M2B3C4D5E6F7G8H9JKMNPQRS",
      scopes: ["ledger:read"],
      tokenId: "token-1",
      credentialId: "agkey_01M2B3C4D5E6F7G8H9JKMNPQRS",
      expiresAt: 2_000_000_000,
    };
    expect(() => assertX402SellerCredentialEligible({ principal: agent })).toThrow(
      /never eligible/,
    );

    expect(() =>
      assertX402SellerCredentialEligible({
        apiKeyCredentialClass: "unsupported" as never,
      }),
    ).toThrow(/requires an x402 pay-per-call credential/);
    expect(() =>
      assertX402SellerCredentialEligible({ apiKeyCredentialClass: "commercial_included" }),
    ).toThrow(/requires an x402 pay-per-call credential/);
    expect(() =>
      assertX402SellerCredentialEligible({ apiKeyCredentialClass: "x402_pay_per_call" }),
    ).not.toThrow();
  });

  it("enforces the complete upfront settlement order", async () => {
    const order: string[] = [];
    const result = await executeX402UpfrontSettlement({
      authenticate: async () => {
        order.push("authenticate");
      },
      reserveAllowance: async () => {
        order.push("reserve");
      },
      createQuote: async () => {
        order.push("quote");
        return requirements;
      },
      captureFacilitatorSupport: async () => {
        order.push("supported");
      },
      facilitator: {
        verify: async () => {
          order.push("verify");
          return { valid: true, payer: "0xpayer", reason: null };
        },
        settle: async () => {
          order.push("settle");
          return {
            success: true,
            payer: "0xpayer",
            transaction: `0x${"c".repeat(64)}`,
            network: X402_BASE_SEPOLIA_NETWORK,
            errorReason: null,
          };
        },
      },
      finality: {
        requireRpcConfirmation: async () => {
          order.push("rpc");
        },
        requireSealed: async () => {
          order.push("sealed");
        },
      },
      paymentPayload: {},
      persistSettlement: async () => {
        order.push("persist-settlement");
      },
      executeHandler: async () => {
        order.push("handler");
        return "fulfilled";
      },
      persistFulfillment: async () => {
        order.push("persist-fulfillment");
      },
      queueMatchingRefund: async () => {
        order.push("refund");
      },
    });
    expect(result).toBe("fulfilled");
    expect(order).toEqual([
      "authenticate",
      "reserve",
      "quote",
      "supported",
      "verify",
      "settle",
      "rpc",
      "sealed",
      "persist-settlement",
      "handler",
      "persist-fulfillment",
    ]);
  });

  it("queues an exact refund after settlement when handler execution fails", async () => {
    const refunds: unknown[] = [];
    await expect(
      executeX402UpfrontSettlement({
        authenticate: async () => undefined,
        reserveAllowance: async () => undefined,
        createQuote: async () => requirements,
        captureFacilitatorSupport: async () => undefined,
        facilitator: {
          verify: async () => ({ valid: true, payer: "0xpayer", reason: null }),
          settle: async () => ({
            success: true,
            payer: "0xpayer",
            transaction: `0x${"d".repeat(64)}`,
            network: X402_BASE_SEPOLIA_NETWORK,
            errorReason: null,
          }),
        },
        finality: {
          requireRpcConfirmation: async () => undefined,
          requireSealed: async () => undefined,
        },
        paymentPayload: {},
        persistSettlement: async () => undefined,
        executeHandler: async () => {
          throw new Error("handler unavailable");
        },
        persistFulfillment: async () => undefined,
        queueMatchingRefund: async (refund) => {
          refunds.push(refund);
        },
      }),
    ).rejects.toThrow("handler unavailable");
    expect(refunds).toEqual([
      {
        transactionHash: `0x${"d".repeat(64)}`,
        payer: "0xpayer",
        reason: "handler unavailable",
      },
    ]);
  });
});
