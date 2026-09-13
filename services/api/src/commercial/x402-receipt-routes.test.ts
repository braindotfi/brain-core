import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "@brain/shared";
import {
  registerX402ReceiptRoutes,
  type X402ReceiptRepository,
  type X402ReceiptState,
} from "./x402-receipt-routes.js";

const TENANT_ID = "tnt_01M2B3C4D5E6F7G8H9JKMNPQRS";
const RECEIPT_ID = "x402rcpt_01M2B3C4D5E6F7G8H9JKMNPQRS";

const receipt: X402ReceiptState = {
  receiptId: RECEIPT_ID,
  logicalOperationId: "x402op_01M2B3C4D5E6F7G8H9JKMNPQRS",
  operationId: "listAccounts",
  operationClass: "api",
  state: "fulfilled",
  network: "eip155:84532",
  assetContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amountAtomic: "10000",
  settlementTransactionHash: `0x${"a".repeat(64)}`,
  refundTransactionHash: null,
  l2Finality: "sealed",
  l1Finality: "not_checked",
  updatedAt: "2026-09-13T12:00:00.000Z",
};

class MemoryRepository implements X402ReceiptRepository {
  async get(_tenantId: string, receiptId: string) {
    return receiptId === RECEIPT_ID ? receipt : null;
  }

  async query(_tenantId: string, receiptIds: readonly string[]) {
    return receiptIds.includes(RECEIPT_ID) ? [receipt] : [];
  }
}

function principal(type: Principal["type"] = "api_partner"): Principal {
  return {
    id: "key_01M2B3C4D5E6F7G8H9JKMNPQRS",
    type,
    tenantId: TENANT_ID,
    scopes: ["ledger:read"],
    tokenId: "token-1",
    expiresAt: 2_000_000_000,
    ...(type === "agent" ? { credentialId: "agkey_01M2B3C4D5E6F7G8H9JKMNPQRS" } : {}),
  };
}

describe("x402 receipt routes", () => {
  let app: FastifyInstance;
  let currentPrincipal: Principal;

  beforeEach(async () => {
    app = Fastify();
    currentPrincipal = principal();
    app.decorateRequest("principal", undefined);
    app.addHook("onRequest", async (request) => {
      request.principal = currentPrincipal;
    });
    await registerX402ReceiptRoutes(app, new MemoryRepository());
  });

  it("returns one authoritative receipt without walking audit history", async () => {
    const response = await app.inject({ method: "GET", url: `/x402/receipts/${RECEIPT_ID}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ receipt_id: RECEIPT_ID, state: "fulfilled" });
  });

  it("returns found and missing states in one bounded query", async () => {
    const missing = "x402rcpt_01M2B3C4D5E6F7G8H9JKMNPQRT";
    const response = await app.inject({
      method: "POST",
      url: "/x402/receipts/query",
      payload: { receipt_ids: [RECEIPT_ID, missing] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().receipts).toEqual([
      expect.objectContaining({ receipt_id: RECEIPT_ID, found: true }),
      { receipt_id: missing, found: false, receipt: null },
    ]);
  });

  it("rejects oversized batches and exchanged brain_ak agent JWTs", async () => {
    const tooMany = Array.from(
      { length: 101 },
      (_, index) => `x402rcpt_${String(index).padStart(26, "0")}`,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/x402/receipts/query",
          payload: { receipt_ids: tooMany },
        })
      ).statusCode,
    ).toBe(400);

    currentPrincipal = principal("agent");
    const denied = await app.inject({ method: "GET", url: `/x402/receipts/${RECEIPT_ID}` });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe("auth_scope_insufficient");
  });
});
