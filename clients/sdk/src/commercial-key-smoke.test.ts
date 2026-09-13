import { describe, expect, it, vi } from "vitest";

import { runCommercialKeySmoke } from "../examples/commercial-key-smoke.js";
import { Brain } from "./brain.js";

describe("commercial API-key smoke example", () => {
  it("uses only read routes covered by commercial API-key scopes", async () => {
    const calls: Request[] = [];
    const fetch = vi.fn(async (input: Request | URL | string) => {
      const request = new Request(input);
      calls.push(request);
      const path = new URL(request.url).pathname;
      const body =
        path === "/v1/ledger/accounts"
          ? { accounts: [], next_cursor: null }
          : path === "/v1/ledger/transactions"
            ? { transactions: [], next_cursor: null }
            : path === "/v1/ledger/balances"
              ? { balances: [] }
              : { anchoring_mode: "db_only" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const brain = new Brain({
      apiKey: "brain_sk_test_smoke",
      baseUrl: "https://api.example.test/v1",
      fetch,
    });

    await expect(runCommercialKeySmoke(brain)).resolves.toEqual({
      accounts: 0,
      transactions: 0,
      balances: 0,
      auditAnchorMode: "db_only",
    });

    expect(calls.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /v1/ledger/accounts",
      "GET /v1/ledger/transactions",
      "GET /v1/ledger/balances",
      "GET /v1/audit/anchor/latest",
    ]);
    expect(
      calls.every(
        (request) => request.headers.get("authorization") === "Bearer brain_sk_test_smoke",
      ),
    ).toBe(true);
  });
});
