import { describe, expect, it, vi } from "vitest";

import { Brain } from "./brain.js";

function mockSequence(responses: Array<{ status: number; body: unknown }>): {
  fetch: typeof globalThis.fetch;
  calls: Request[];
} {
  const calls: Request[] = [];
  let i = 0;
  const fn = vi.fn(async (input: Request | URL | string) => {
    calls.push(input as Request);
    const r = responses[i++];
    if (!r) throw new Error(`ran out of mocked responses at call ${i}`);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

describe("Brain.snapshot", () => {
  it("aggregates balances, recent transactions, and open obligations in parallel", async () => {
    const { fetch, calls } = mockSequence([
      { status: 200, body: { balances: [{ current: "100" }] } },
      { status: 200, body: { transactions: [{ id: "tx_1" }], next_cursor: null } },
      { status: 200, body: { obligations: [{ id: "obl_1" }] } },
    ]);
    const brain = new Brain({ apiKey: "k", fetch });

    const snap = await brain.snapshot("acme");

    expect(snap.balances).toHaveLength(1);
    expect(snap.recentTransactions).toHaveLength(1);
    expect(snap.openObligations).toHaveLength(1);
    expect(snap.asOf).toMatch(/^\d{4}-/);
    const urls = calls.map((c) => c.url);
    expect(urls.some((u) => u.includes("/ledger/balances"))).toBe(true);
    expect(urls.some((u) => u.includes("/ledger/transactions"))).toBe(true);
    expect(urls.some((u) => u.includes("/ledger/obligations"))).toBe(true);
  });

  it("honors recentTransactionLimit option", async () => {
    const { fetch, calls } = mockSequence([
      { status: 200, body: { balances: [] } },
      { status: 200, body: { transactions: [], next_cursor: null } },
      { status: 200, body: { obligations: [] } },
    ]);
    const brain = new Brain({ apiKey: "k", fetch });

    await brain.snapshot("acme", { recentTransactionLimit: 5 });

    const txCall = calls.find((c) => c.url.includes("/ledger/transactions"));
    expect(txCall?.url).toContain("limit=5");
  });
});

describe("Brain.trace", () => {
  it("fetches entity history then resolves each event's inclusion proof", async () => {
    const { fetch, calls } = mockSequence([
      {
        status: 200,
        body: {
          entity_type: "payment_intent",
          entity_id: "pi_1",
          events: [{ id: "evt_a" }, { id: "evt_b" }],
        },
      },
      {
        status: 200,
        body: {
          event: { id: "evt_a" },
          inclusion_proof: { merkle_root: "0xa" },
        },
      },
      {
        status: 200,
        body: {
          event: { id: "evt_b" },
          inclusion_proof: { merkle_root: "0xb" },
        },
      },
    ]);
    const brain = new Brain({ apiKey: "k", fetch });

    const trace = await brain.trace("pi_1");

    expect(trace.entityType).toBe("payment_intent");
    expect(trace.entityId).toBe("pi_1");
    expect(trace.entries).toHaveLength(2);
    expect(trace.entries[0]?.inclusionProof.merkleRoot).toBe("0xa");
    expect(trace.entries[1]?.inclusionProof.merkleRoot).toBe("0xb");
    expect(calls[0]?.url).toContain("/audit/entity/payment_intent/pi_1");
    expect(calls[1]?.url).toContain("/audit/event/evt_");
  });

  it("defaults entityType=payment_intent; allows override", async () => {
    const { fetch, calls } = mockSequence([
      {
        status: 200,
        body: { events: [] },
      },
    ]);
    const brain = new Brain({ apiKey: "k", fetch });

    await brain.trace("tx_1", { entityType: "transaction" });

    expect(calls[0]?.url).toContain("/audit/entity/transaction/tx_1");
  });

  it("skips events without an id", async () => {
    const { fetch, calls } = mockSequence([
      {
        status: 200,
        body: {
          events: [{ id: "evt_a" }, { other: 1 }],
        },
      },
      {
        status: 200,
        body: {
          event: { id: "evt_a" },
          inclusion_proof: {},
        },
      },
    ]);
    const brain = new Brain({ apiKey: "k", fetch });

    const trace = await brain.trace("pi_1");

    expect(trace.entries).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});

describe("Brain.cashFlow.summarize", () => {
  it("sums inflows and outflows across paginated transactions", async () => {
    const { fetch, calls } = mockSequence([
      {
        status: 200,
        body: {
          transactions: [
            { direction: "inflow", amount: "100.00" },
            { direction: "outflow", amount: "30.00" },
          ],
          next_cursor: "c1",
        },
      },
      {
        status: 200,
        body: {
          transactions: [
            { direction: "inflow", amount: "50.00" },
            { direction: "transfer", amount: "10.00" },
            { direction: "outflow", amount: "20.00" },
          ],
          next_cursor: null,
        },
      },
    ]);
    const brain = new Brain({ apiKey: "k", fetch });

    const summary = await brain.cashFlow.summarize({
      tenantId: "acme",
      since: "2026-05-01",
      until: "2026-05-31",
      currency: "USD",
    });

    expect(summary.inflows).toBe(150);
    expect(summary.outflows).toBe(50);
    expect(summary.net).toBe(100);
    expect(summary.transactionCount).toBe(5);
    expect(summary.currency).toBe("USD");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain("cursor=c1");
  });

  it("ignores transactions with no parseable amount", async () => {
    const { fetch } = mockSequence([
      {
        status: 200,
        body: {
          transactions: [
            { direction: "inflow", amount: "abc" },
            { direction: "outflow" },
            { direction: "inflow", amount: 25 },
          ],
          next_cursor: null,
        },
      },
    ]);
    const brain = new Brain({ apiKey: "k", fetch });

    const summary = await brain.cashFlow.summarize({
      tenantId: "acme",
      since: "2026-05-01",
      until: "2026-05-31",
    });

    expect(summary.inflows).toBe(25);
    expect(summary.outflows).toBe(0);
    expect(summary.transactionCount).toBe(1);
  });

  it("forwards accountId filter when provided", async () => {
    const { fetch, calls } = mockSequence([
      { status: 200, body: { transactions: [], next_cursor: null } },
    ]);
    const brain = new Brain({ apiKey: "k", fetch });

    await brain.cashFlow.summarize({
      tenantId: "acme",
      since: "2026-05-01",
      until: "2026-05-31",
      accountId: "acct_1",
    });

    expect(calls[0]?.url).toContain("account_id=acct_1");
  });
});
