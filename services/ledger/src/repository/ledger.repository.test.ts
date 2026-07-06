import { describe, expect, it, vi } from "vitest";
import type { TenantScopedClient } from "@brain/shared";
import { findTransactionById, listTransactions } from "./transactions.js";
import { findLatestBalance, listBalances } from "./balances.js";
import { findCategoryById, listCategories } from "./categories.js";
import { findDocumentById, listDocuments } from "./documents.js";
import { findInvoiceById, listInvoices } from "./invoices.js";
import { findObligationById, listObligations } from "./obligations.js";
import { findTransferById, listTransfers } from "./transfers.js";
import { listCounterparties } from "./counterparties.js";

type FakeClient = TenantScopedClient & { _log: { sql: string; values: unknown[] }[] };

function fakeClient(rows: unknown[] = []): FakeClient {
  const log: { sql: string; values: unknown[] }[] = [];
  const client = {
    _log: log,
    query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
      log.push({ sql, values: Array.from(values ?? []) });
      return { rows: [...rows], rowCount: rows.length };
    }),
  };
  return client as unknown as FakeClient;
}

// ---- transactions ----

describe("findTransactionById", () => {
  it("queries by id and returns null when not found", async () => {
    const { _log, ...client } = fakeClient();
    expect(await findTransactionById(client, "txn_1")).toBeNull();
    expect(_log[0]!.sql).toContain("WHERE id = $1");
    expect(_log[0]!.values).toEqual(["txn_1"]);
  });
});

describe("listTransactions", () => {
  it("queries with limit only", async () => {
    const { _log, ...client } = fakeClient();
    await listTransactions(client, { limit: 25 });
    expect(_log[0]!.sql).not.toContain("WHERE");
    expect(_log[0]!.values).toContain(25);
  });

  it("adds account_id, direction, status filters", async () => {
    const { _log, ...client } = fakeClient();
    await listTransactions(client, {
      account_id: "acct_1",
      direction: "debit",
      status: "posted",
      limit: 10,
    });
    expect(_log[0]!.sql).toContain("account_id = $1");
    expect(_log[0]!.sql).toContain("direction = $2");
    expect(_log[0]!.sql).toContain("status = $3");
  });

  it("adds since and until date filters", async () => {
    const { _log, ...client } = fakeClient();
    const since = new Date("2024-01-01");
    const until = new Date("2024-12-31");
    await listTransactions(client, { since, until, limit: 5 });
    expect(_log[0]!.sql).toContain("transaction_date >= $1");
    expect(_log[0]!.sql).toContain("transaction_date <= $2");
    expect(_log[0]!.values).toContain(since);
    expect(_log[0]!.values).toContain(until);
  });

  it("orders by transaction_date DESC", async () => {
    const { _log, ...client } = fakeClient();
    await listTransactions(client, { limit: 1 });
    expect(_log[0]!.sql).toMatch(/ORDER BY transaction_date DESC/);
  });
});

// ---- balances ----

describe("findLatestBalance", () => {
  it("queries by account_id ordered desc and returns null when empty", async () => {
    const { _log, ...client } = fakeClient();
    const result = await findLatestBalance(client, "acct_1");
    expect(result).toBeNull();
    expect(_log[0]!.sql).toContain("account_id = $1");
    expect(_log[0]!.sql).toMatch(/ORDER BY as_of DESC/);
  });
});

describe("listBalances", () => {
  it("queries with no filters", async () => {
    const { _log, ...client } = fakeClient();
    await listBalances(client, {});
    expect(_log[0]!.sql).not.toContain("WHERE");
  });

  it("adds account_id and as_of filters", async () => {
    const { _log, ...client } = fakeClient();
    const asOf = new Date("2024-01-01");
    await listBalances(client, { account_id: "acct_1", as_of: asOf });
    expect(_log[0]!.sql).toContain("account_id = $1");
    expect(_log[0]!.sql).toContain("as_of <= $2");
    expect(_log[0]!.values).toEqual(["acct_1", asOf]);
  });
});

// ---- categories ----

describe("findCategoryById", () => {
  it("queries by id and returns null when not found", async () => {
    const { _log, ...client } = fakeClient();
    expect(await findCategoryById(client, "cat_1")).toBeNull();
    expect(_log[0]!.sql).toContain("id = $1");
  });
});

describe("listCategories", () => {
  it("queries with limit only", async () => {
    const { _log, ...client } = fakeClient();
    await listCategories(client, { limit: 10 });
    expect(_log[0]!.sql).not.toContain("kind");
    expect(_log[0]!.values).toContain(10);
  });

  it("adds kind filter when provided", async () => {
    const { _log, ...client } = fakeClient();
    await listCategories(client, { kind: "expense", limit: 5 });
    expect(_log[0]!.sql).toContain("kind = $1");
    expect(_log[0]!.values).toEqual(["expense", 5]);
  });
});

// ---- documents ----

describe("findDocumentById", () => {
  it("queries by id", async () => {
    const { _log, ...client } = fakeClient();
    expect(await findDocumentById(client, "doc_1")).toBeNull();
    expect(_log[0]!.sql).toContain("id = $1");
  });
});

describe("listDocuments", () => {
  it("adds document_type filter", async () => {
    const { _log, ...client } = fakeClient();
    await listDocuments(client, { document_type: "invoice", limit: 20 });
    expect(_log[0]!.sql).toContain("document_type = $1");
    expect(_log[0]!.values).toEqual(["invoice", 20]);
  });
});

// ---- invoices ----

describe("findInvoiceById", () => {
  it("queries by id", async () => {
    const { _log, ...client } = fakeClient();
    expect(await findInvoiceById(client, "inv_1")).toBeNull();
    expect(_log[0]!.sql).toContain("id = $1");
  });
});

describe("listInvoices", () => {
  it("adds status and counterparty_id filters", async () => {
    const { _log, ...client } = fakeClient();
    await listInvoices(client, { status: "open", counterparty_id: "cp_1", limit: 15 });
    expect(_log[0]!.sql).toContain("status = $1");
    expect(_log[0]!.sql).toContain("counterparty_id = $2");
    expect(_log[0]!.values).toEqual(["open", "cp_1", 15]);
  });
});

// ---- counterparties ----

describe("listCounterparties", () => {
  it("adds verified_status filter", async () => {
    const { _log, ...client } = fakeClient();
    await listCounterparties(client, { verified_status: "unverified", limit: 20 });
    expect(_log[0]!.sql).toContain("verified_status = $1");
    expect(_log[0]!.values).toEqual(["unverified", 20]);
  });

  it("searches normalized names and aliases", async () => {
    const { _log, ...client } = fakeClient();
    await listCounterparties(client, { q: "Acme Trading", limit: 20 });
    expect(_log[0]!.sql).toContain("LOWER(COALESCE(normalized_name, '')) LIKE $1");
    expect(_log[0]!.sql).toContain("FROM unnest(aliases) AS alias");
    expect(_log[0]!.values).toEqual(["%acme_trading%", "Acme Trading", 20]);
  });
});

// ---- obligations ----

describe("findObligationById", () => {
  it("queries by id", async () => {
    const { _log, ...client } = fakeClient();
    expect(await findObligationById(client, "obl_1")).toBeNull();
    expect(_log[0]!.sql).toContain("id = $1");
  });
});

describe("listObligations", () => {
  it("adds due_before filter", async () => {
    const { _log, ...client } = fakeClient();
    const due = new Date("2024-12-31");
    await listObligations(client, { due_before: due, limit: 5 });
    expect(_log[0]!.sql).toContain("due_date <= $");
    expect(_log[0]!.values).toContain(due);
  });

  it("orders by due_date ASC", async () => {
    const { _log, ...client } = fakeClient();
    await listObligations(client, { limit: 10 });
    expect(_log[0]!.sql).toMatch(/ORDER BY due_date ASC/);
  });
});

// ---- transfers ----

describe("findTransferById", () => {
  it("queries by id", async () => {
    const { _log, ...client } = fakeClient();
    expect(await findTransferById(client, "xfr_1")).toBeNull();
    expect(_log[0]!.sql).toContain("id = $1");
  });
});

describe("listTransfers", () => {
  it("adds account_id OR filter for from/to", async () => {
    const { _log, ...client } = fakeClient();
    await listTransfers(client, { account_id: "acct_1", limit: 10 });
    expect(_log[0]!.sql).toContain("from_account_id = $1");
    expect(_log[0]!.sql).toContain("to_account_id = $1");
    expect(_log[0]!.values).toContain("acct_1");
  });

  it("adds status filter", async () => {
    const { _log, ...client } = fakeClient();
    await listTransfers(client, { status: "settled", limit: 10 });
    expect(_log[0]!.sql).toContain("status = $1");
    expect(_log[0]!.values).toEqual(["settled", 10]);
  });
});
