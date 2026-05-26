import { describe, expect, it, vi } from "vitest";

import { Brain, BRAIN_BASE_URLS } from "./brain.js";
import { BrainAPIError } from "./errors.js";

function mockFetch(
  status: number,
  body: unknown,
): { fetch: typeof globalThis.fetch; calls: Request[] } {
  const calls: Request[] = [];
  const fn = vi.fn(async (input: Request | URL | string) => {
    calls.push(input as Request);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

describe("Brain", () => {
  it("constructs sub-resources from a single token", () => {
    const brain = new Brain({ token: "k" });
    expect(brain.accounts).toBeDefined();
    expect(brain.transactions).toBeDefined();
    expect(brain.counterparties).toBeDefined();
    expect(brain.obligations).toBeDefined();
    expect(brain.invoices).toBeDefined();
    expect(brain.balances).toBeDefined();
    expect(brain.http).toBeDefined();
  });

  describe("local()", () => {
    it("points baseUrl at localhost:3000/v1", () => {
      const brain = Brain.local("tok");
      expect(brain.baseUrl).toBe(BRAIN_BASE_URLS.local);
    });

    it("passes through extra options", () => {
      const fetchFn = vi.fn() as unknown as typeof globalThis.fetch;
      const brain = Brain.local("tok", { fetch: fetchFn });
      expect(brain.getFetch()).toBe(fetchFn);
    });
  });

  describe("fromDemoServer()", () => {
    it("fetches a demo token and constructs a Brain pointed at baseUrl", async () => {
      const calls: string[] = [];
      const fetchFn = vi.fn(async (input: Request | URL | string) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        calls.push(url);
        if (url.endsWith("/demo/token")) {
          return new Response(JSON.stringify({ token: "demo_token_abcdef" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      }) as unknown as typeof globalThis.fetch;

      const brain = await Brain.fromDemoServer("http://localhost:3000/v1", { fetch: fetchFn });

      expect(calls[0]).toContain("/demo/token");
      expect(brain.baseUrl).toBe("http://localhost:3000/v1");
      expect(brain.getMaskedToken()).toContain("demo_token_");
    });

    it("throws a descriptive error when the demo token request fails", async () => {
      const fetchFn = vi.fn(
        async () => new Response("", { status: 503 }),
      ) as unknown as typeof globalThis.fetch;

      await expect(
        Brain.fromDemoServer("http://localhost:3000/v1", { fetch: fetchFn }),
      ).rejects.toThrow("status 503");
    });

    it("uses default baseUrl when none supplied", async () => {
      const fetchFn = vi.fn(
        async () =>
          new Response(JSON.stringify({ token: "t" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ) as unknown as typeof globalThis.fetch;

      const brain = await Brain.fromDemoServer(undefined, { fetch: fetchFn });
      expect(brain.baseUrl).toBe("http://localhost:3000/v1");
    });
  });

  describe("accounts", () => {
    it("list returns accounts array and nextCursor", async () => {
      const { fetch, calls } = mockFetch(200, {
        accounts: [{ id: "acct_1" }, { id: "acct_2" }],
        next_cursor: "abc",
      });
      const brain = new Brain({ token: "k", fetch });

      const page = await brain.accounts.list({ status: "active" });

      expect(page.accounts).toHaveLength(2);
      expect(page.nextCursor).toBe("abc");
      expect(calls[0]?.url).toContain("/ledger/accounts?status=active");
    });

    it("list defaults nextCursor to null when missing", async () => {
      const { fetch } = mockFetch(200, { accounts: [] });
      const brain = new Brain({ token: "k", fetch });

      const page = await brain.accounts.list();

      expect(page.accounts).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });

    it("get returns account and latestBalance", async () => {
      const { fetch, calls } = mockFetch(200, {
        account: { id: "acct_1", display_name: "Checking" },
        latest_balance: { current: "100.00" },
      });
      const brain = new Brain({ token: "k", fetch });

      const detail = await brain.accounts.get("acct_1");

      expect(detail.account.id).toBe("acct_1");
      expect(detail.latestBalance).toEqual({ current: "100.00" });
      expect(calls[0]?.url).toContain("/ledger/accounts/acct_1");
    });

    it("throws BrainAPIError on 4xx with typed body", async () => {
      const { fetch } = mockFetch(404, {
        code: "not_found",
        message: "Account not found",
        trace_id: "trace-1",
      });
      const brain = new Brain({ token: "k", fetch });

      await expect(brain.accounts.get("missing")).rejects.toMatchObject({
        name: "BrainAPIError",
        status: 404,
        code: "not_found",
        traceId: "trace-1",
      });
    });

    it("throws when 200 body is missing the account field", async () => {
      const { fetch } = mockFetch(200, {});
      const brain = new Brain({ token: "k", fetch });

      await expect(brain.accounts.get("acct_1")).rejects.toBeInstanceOf(BrainAPIError);
    });
  });

  describe("transactions", () => {
    it("list returns transactions array", async () => {
      const { fetch, calls } = mockFetch(200, {
        transactions: [{ id: "tx_1" }],
        next_cursor: null,
      });
      const brain = new Brain({ token: "k", fetch });

      const page = await brain.transactions.list({
        direction: "inflow",
        limit: 50,
      });

      expect(page.transactions).toHaveLength(1);
      expect(page.nextCursor).toBeNull();
      expect(calls[0]?.url).toContain("direction=inflow");
      expect(calls[0]?.url).toContain("limit=50");
    });

    it("get returns the raw Transaction body", async () => {
      const tx = { id: "tx_1", amount: "50.00" };
      const { fetch, calls } = mockFetch(200, tx);
      const brain = new Brain({ token: "k", fetch });

      const result = await brain.transactions.get("tx_1");

      expect(result).toEqual(tx);
      expect(calls[0]?.url).toContain("/ledger/transactions/tx_1");
    });
  });

  describe("counterparties", () => {
    it("list returns counterparties array (no pagination)", async () => {
      const { fetch } = mockFetch(200, {
        counterparties: [{ id: "cp_1" }, { id: "cp_2" }, { id: "cp_3" }],
      });
      const brain = new Brain({ token: "k", fetch });

      const list = await brain.counterparties.list({ q: "stripe" });

      expect(list).toHaveLength(3);
    });

    it("list returns empty array when body has no counterparties", async () => {
      const { fetch } = mockFetch(200, {});
      const brain = new Brain({ token: "k", fetch });

      const list = await brain.counterparties.list();

      expect(list).toEqual([]);
    });
  });

  describe("obligations", () => {
    it("list returns obligations array", async () => {
      const { fetch } = mockFetch(200, {
        obligations: [{ id: "obl_1" }],
      });
      const brain = new Brain({ token: "k", fetch });

      const list = await brain.obligations.list({ status: "due" });

      expect(list).toHaveLength(1);
    });
  });

  describe("invoices", () => {
    it("list returns invoices array", async () => {
      const { fetch } = mockFetch(200, {
        invoices: [{ id: "inv_1" }],
      });
      const brain = new Brain({ token: "k", fetch });

      const list = await brain.invoices.list();

      expect(list).toHaveLength(1);
    });
  });

  describe("balances", () => {
    it("list returns balances array", async () => {
      const { fetch } = mockFetch(200, {
        balances: [{ account_id: "acct_1", current: "100.00" }],
      });
      const brain = new Brain({ token: "k", fetch });

      const list = await brain.balances.list({ account_id: "acct_1" });

      expect(list).toHaveLength(1);
    });
  });

  describe("BrainAPIError fallback", () => {
    it("uses 'unknown' code and a default message when body is undefined", () => {
      const err = new BrainAPIError(500, undefined);
      expect(err.code).toBe("unknown");
      expect(err.message).toContain("status 500");
      expect(err.traceId).toBeUndefined();
      expect(err.details).toBeUndefined();
    });

    it("preserves structured details when body provides them", () => {
      const err = new BrainAPIError(422, {
        code: "validation_failed",
        message: "bad input",
        details: { field: "amount" },
      });
      expect(err.details).toEqual({ field: "amount" });
    });
  });
});
