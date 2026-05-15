import { beforeEach, describe, expect, it } from "vitest";
import { Brain, type FetchLike } from "../index.js";

interface Call {
  url: string;
  method: string;
}

function makeBrain(response: unknown, status = 200): { brain: Brain; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  const brain = new Brain({ apiKey: "brain_sk_test_x", fetch });
  return { brain, calls };
}

describe("brain.accounts", () => {
  let brain: Brain;
  let calls: Call[];

  beforeEach(() => {
    ({ brain, calls } = makeBrain({
      accounts: [{ id: "acc_1" }, { id: "acc_2" }],
      next_cursor: null,
    }));
  });

  it("list() calls GET /ledger/accounts with tenantId", async () => {
    const page = await brain.accounts.list("acme");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/ledger/accounts");
    expect(calls[0]?.url).toContain("tenantId=acme");
    expect(page.data).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("list() forwards status, accountType, limit, cursor", async () => {
    await brain.accounts.list("acme", {
      status: "active",
      accountType: "bank_checking",
      limit: 50,
      cursor: "c_x",
    });
    expect(calls[0]?.url).toContain("status=active");
    expect(calls[0]?.url).toContain("account_type=bank_checking");
    expect(calls[0]?.url).toContain("limit=50");
    expect(calls[0]?.url).toContain("cursor=c_x");
  });

  it("get() URL-encodes the account id", async () => {
    ({ brain, calls } = makeBrain({
      account: { id: "acc/weird" },
      latest_balance: {},
    }));
    await brain.accounts.get("acme", "acc/weird");
    expect(calls[0]?.url).toContain("/ledger/accounts/acc%2Fweird");
  });
});

describe("brain.transactions", () => {
  let brain: Brain;
  let calls: Call[];

  beforeEach(() => {
    ({ brain, calls } = makeBrain({
      transactions: [{ id: "tx_1" }],
      next_cursor: "next",
    }));
  });

  it("list() translates from/to to since/until on the wire", async () => {
    const page = await brain.transactions.list("acme", {
      from: "2026-01-01",
      to: "2026-03-31",
      direction: "outflow",
      limit: 100,
    });
    expect(calls[0]?.url).toContain("since=2026-01-01");
    expect(calls[0]?.url).toContain("until=2026-03-31");
    expect(calls[0]?.url).toContain("direction=outflow");
    expect(calls[0]?.url).toContain("limit=100");
    expect(page.nextCursor).toBe("next");
  });

  it("get() hits /ledger/transactions/{id}", async () => {
    ({ brain, calls } = makeBrain({ id: "tx_x" }));
    await brain.transactions.get("acme", "tx_x");
    expect(calls[0]?.url).toContain("/ledger/transactions/tx_x");
    expect(calls[0]?.url).toContain("tenantId=acme");
  });
});

describe("brain.balances", () => {
  it("list() calls GET /ledger/balances with as_of when set", async () => {
    const { brain, calls } = makeBrain({ balances: [] });
    await brain.balances.list("acme", { asOf: "2026-01-15T00:00:00Z" });
    expect(calls[0]?.url).toContain("/ledger/balances");
    expect(calls[0]?.url).toContain("as_of=2026-01-15T00%3A00%3A00Z");
  });
});

describe("brain.counterparties", () => {
  it("list() forwards q + type + sortBy", async () => {
    const { brain, calls } = makeBrain({ counterparties: [] });
    await brain.counterparties.list("acme", {
      q: "AWS",
      type: "vendor",
      sortBy: "activity",
      limit: 20,
    });
    expect(calls[0]?.url).toContain("q=AWS");
    expect(calls[0]?.url).toContain("type=vendor");
    expect(calls[0]?.url).toContain("sort_by=activity");
  });
});

describe("brain.obligations", () => {
  it("list() supports the status + due_before filters", async () => {
    const { brain, calls } = makeBrain({ obligations: [] });
    await brain.obligations.list("acme", {
      status: "overdue",
      dueBefore: "2026-06-01",
    });
    expect(calls[0]?.url).toContain("status=overdue");
    expect(calls[0]?.url).toContain("due_before=2026-06-01");
  });
});

describe("brain.invoices", () => {
  it("list() supports status + counterpartyId", async () => {
    const { brain, calls } = makeBrain({ invoices: [] });
    await brain.invoices.list("acme", {
      status: "sent",
      counterpartyId: "cp_1",
    });
    expect(calls[0]?.url).toContain("status=sent");
    expect(calls[0]?.url).toContain("counterparty_id=cp_1");
  });
});
