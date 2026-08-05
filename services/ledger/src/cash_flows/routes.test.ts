import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  errorHandlerPlugin,
  newTenantId,
  newUserId,
  type Principal,
  type Scope,
} from "@brain/shared";
import { registerCashFlowRoutes } from "./routes.js";
import type { LedgerService } from "../service/LedgerService.js";

const tenantId = newTenantId();

function principal(): Principal {
  return {
    id: newUserId(),
    type: "user",
    tenantId,
    scopes: ["ledger:read"] as Scope[],
    tokenId: "tok_cash_flows",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

async function buildApp(service: Partial<LedgerService>) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request: FastifyRequest) => {
    request.principal = principal();
  });
  await registerCashFlowRoutes(app, service as LedgerService);
  return app;
}

function transaction(i: number) {
  return {
    id: `tx_${i}`,
    transaction_date: "2026-07-01T00:00:00.000Z",
    amount: "10.00",
    currency: "USD",
    direction: "inflow" as const,
  };
}

describe("GET /ledger/cash_flows", () => {
  // F6 regression: a single 1000-row fetch silently under-reported totals for
  // any tenant with more than 1000 transactions in the window. The route must
  // follow the cursor instead of stopping at the first page.
  it("pages through more than 1000 transactions instead of truncating at one page", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => transaction(i));
    const page2 = Array.from({ length: 250 }, (_, i) => transaction(1000 + i));
    const listTransactions = vi
      .fn()
      .mockResolvedValueOnce({ items: page1, next_cursor: "cursor_1" })
      .mockResolvedValueOnce({ items: page2, next_cursor: null });

    const app = await buildApp({ listTransactions: listTransactions as never });
    const res = await app.inject({ method: "GET", url: "/ledger/cash_flows" });

    expect(res.statusCode).toBe(200);
    expect(listTransactions).toHaveBeenCalledTimes(2);
    const body = res.json();
    expect(body.currencies[0].transaction_count).toBe(1250);
    expect(res.headers["x-cash-flow-truncated"]).toBeUndefined();
  });

  // F6 regression: ?currency=EUR was applied post-fetch over a single
  // USD-dominant page, so a USD-heavy tenant got a near-empty EUR summary
  // even when EUR transactions existed further back in the window.
  it("pushes the currency filter into the query instead of filtering post-fetch", async () => {
    const listTransactions = vi.fn().mockResolvedValue({ items: [], next_cursor: null });
    const app = await buildApp({ listTransactions: listTransactions as never });

    await app.inject({ method: "GET", url: "/ledger/cash_flows?currency=EUR" });

    expect(listTransactions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ currency: "EUR" }),
    );
  });

  it("marks the response truncated once the safety ceiling is hit", async () => {
    const bigPage = Array.from({ length: 1000 }, (_, i) => transaction(i));
    const listTransactions = vi.fn().mockImplementation(async () => ({
      items: bigPage,
      next_cursor: "keep_going",
    }));

    const app = await buildApp({ listTransactions: listTransactions as never });
    const res = await app.inject({ method: "GET", url: "/ledger/cash_flows" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cash-flow-truncated"]).toBe("true");
    // 20 pages of 1000 = the MAX_TRANSACTIONS ceiling.
    expect(listTransactions).toHaveBeenCalledTimes(20);
  });
});
