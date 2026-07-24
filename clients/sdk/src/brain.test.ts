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
        error: {
          code: "not_found",
          message: "Account not found",
          request_id: "trace-1",
          docs_url: "https://docs.brain.fi/resources/errors#not_found",
        },
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
    it("list returns a backward-compatible counterparty array with nextCursor", async () => {
      const { fetch, calls } = mockFetch(200, {
        counterparties: [{ id: "cp_1" }, { id: "cp_2" }, { id: "cp_3" }],
        next_cursor: "cp_cursor",
      });
      const brain = new Brain({ token: "k", fetch });

      const list = await brain.counterparties.list({ q: "stripe", limit: 3, cursor: "old" });

      expect(list).toHaveLength(3);
      expect(list.counterparties).toHaveLength(3);
      expect(list.nextCursor).toBe("cp_cursor");
      expect(calls[0]?.url).toContain("limit=3");
      expect(calls[0]?.url).toContain("cursor=old");
    });

    it("list returns empty array when body has no counterparties", async () => {
      const { fetch } = mockFetch(200, {});
      const brain = new Brain({ token: "k", fetch });

      const list = await brain.counterparties.list();

      expect(list).toEqual([]);
      expect(list.nextCursor).toBeNull();
    });

    it("get fetches a single counterparty by id", async () => {
      const { fetch, calls } = mockFetch(200, { id: "cp_1", name: "Acme Vendor" });
      const brain = new Brain({ token: "k", fetch });

      const cp = await brain.counterparties.get("cp_1");

      expect(cp.id).toBe("cp_1");
      expect(calls[0]?.url).toContain("/ledger/counterparties/cp_1");
    });

    it("get propagates a 404 as BrainAPIError", async () => {
      const { fetch } = mockFetch(404, {
        error: {
          code: "ledger_row_not_found",
          message: "no such counterparty",
          request_id: "req_1",
          docs_url: "https://docs.brain.fi/resources/errors#ledger_row_not_found",
        },
      });
      const brain = new Brain({ token: "k", fetch });

      await expect(brain.counterparties.get("cp_missing")).rejects.toMatchObject({
        status: 404,
      });
    });

    it("create posts identity fields and returns the created counterparty", async () => {
      const { fetch, calls } = mockFetch(201, {
        counterparty: { id: "cp_1", name: "Acme Vendor", type: "vendor" },
        created: true,
      });
      const brain = new Brain({ token: "k", fetch });

      const result = await brain.counterparties.create({ name: "Acme Vendor", type: "vendor" });

      expect(result.created).toBe(true);
      expect(result.counterparty?.id).toBe("cp_1");
      const sent = await calls[0]!.text();
      expect(sent).toContain('"name":"Acme Vendor"');
    });

    it("create surfaces payment_fields_not_allowed as a 400 BrainAPIError", async () => {
      const { fetch } = mockFetch(400, {
        error: {
          code: "request_body_invalid",
          message: "payment fields not allowed",
          request_id: "req_1",
          docs_url: "https://docs.brain.fi/resources/errors#request_body_invalid",
          details: { reason: "payment_fields_not_allowed", fields: ["iban"] },
        },
      });
      const brain = new Brain({ token: "k", fetch });

      await expect(
        brain.counterparties.create({
          name: "Acme Vendor",
          type: "vendor",
          // @ts-expect-error -- payment fields are intentionally not part of the typed body
          iban: "DE89370400440532013000",
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("update patches identity fields by id", async () => {
      const { fetch, calls } = mockFetch(200, {
        counterparty: { id: "cp_1", name: "Acme Vendor Renamed" },
      });
      const brain = new Brain({ token: "k", fetch });

      const result = await brain.counterparties.update("cp_1", { name: "Acme Vendor Renamed" });

      expect(result.counterparty?.name).toBe("Acme Vendor Renamed");
      expect(calls[0]?.method).toBe("PATCH");
      expect(calls[0]?.url).toContain("/ledger/counterparties/cp_1");
    });

    it("update surfaces a 409 name_conflict as BrainAPIError", async () => {
      const { fetch } = mockFetch(409, {
        error: {
          code: "ledger_reconciliation_conflict",
          message: "rename conflicts with another counterparty",
          request_id: "req_1",
          docs_url: "https://docs.brain.fi/resources/errors#ledger_reconciliation_conflict",
          details: { reason: "name_conflict" },
        },
      });
      const brain = new Brain({ token: "k", fetch });

      await expect(
        brain.counterparties.update("cp_1", { name: "Existing Name" }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("obligations", () => {
    it("list returns a backward-compatible obligation array with nextCursor", async () => {
      const { fetch } = mockFetch(200, {
        obligations: [{ id: "obl_1" }],
        next_cursor: "obl_cursor",
      });
      const brain = new Brain({ token: "k", fetch });

      const list = await brain.obligations.list({ status: "due" });

      expect(list).toHaveLength(1);
      expect(list.obligations).toHaveLength(1);
      expect(list.nextCursor).toBe("obl_cursor");
    });
  });

  describe("invoices", () => {
    it("list returns a backward-compatible invoice array with nextCursor", async () => {
      const { fetch } = mockFetch(200, {
        invoices: [{ id: "inv_1" }],
        next_cursor: "inv_cursor",
      });
      const brain = new Brain({ token: "k", fetch });

      const list = await brain.invoices.list();

      expect(list).toHaveLength(1);
      expect(list.invoices).toHaveLength(1);
      expect(list.nextCursor).toBe("inv_cursor");
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
        error: {
          code: "validation_failed",
          message: "bad input",
          details: { field: "amount" },
          request_id: "req_1",
          docs_url: "https://docs.brain.fi/resources/errors#validation_failed",
        },
      });
      expect(err.details).toEqual({ field: "amount" });
    });

    it("unwraps the nested { error: {...} } envelope and prefers request_id", () => {
      const err = new BrainAPIError(401, {
        error: {
          code: "auth_token_invalid",
          message: "JWT verification failed",
          request_id: "req_123",
          docs_url: "https://docs.brain.fi/resources/errors#auth_token_invalid",
          details: { reason: "Invalid Compact JWS" },
        },
      });
      expect(err.code).toBe("auth_token_invalid");
      expect(err.traceId).toBe("req_123");
      expect(err.details).toEqual({ reason: "Invalid Compact JWS" });
    });
  });
});
