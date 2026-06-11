import { describe, expect, it } from "vitest";
import {
  interpreterForSchema,
  registeredSchemas,
  registerInterpreter,
  type InterpreterArtifactContext,
} from "./registry.js";

function ctx(over: Partial<InterpreterArtifactContext> = {}): InterpreterArtifactContext {
  return {
    rawArtifactId: "raw_1",
    tenantId: "tnt_1",
    sourceType: "stripe",
    sourceSchema: "stripe.balance_transactions.v1",
    sourceRef: { stripe_account_id: "acct_stripe1" },
    sourceId: "src_1",
    objectType: "balance_transaction",
    ...over,
  };
}

describe("interpreter registry", () => {
  it("registers the built-in plaid and stripe page schemas", () => {
    expect(registeredSchemas()).toEqual(
      expect.arrayContaining([
        "plaid.transactions_sync.v1",
        "stripe.balance_transactions.v1",
        "stripe.charges.v1",
        "stripe.payouts.v1",
        "stripe.refunds.v1",
        "stripe.disputes.v1",
        "stripe.customers.v1",
      ]),
    );
  });

  it("returns undefined for an unregistered schema (artifact waits for a parser)", () => {
    expect(interpreterForSchema("acme_neobank.warehouse_tx.v1")).toBeUndefined();
  });

  it("refuses duplicate registration", () => {
    expect(() => registerInterpreter("plaid.transactions_sync.v1", () => null)).toThrow(
      /already registered/,
    );
  });

  it("reshapes a plaid transactions/sync page into the plaid_tx_v1 payload", () => {
    const page = {
      accounts: [{ account_id: "a1", name: "Chase", type: "depository" }],
      added: [{ transaction_id: "t1", account_id: "a1", amount: 4.5, date: "2026-06-01" }],
      modified: [{ transaction_id: "t2", account_id: "a1", amount: 9, date: "2026-06-02" }],
      removed: [{ transaction_id: "t3" }],
      next_cursor: "c2",
      request_id: "req_x",
    };
    const out = interpreterForSchema("plaid.transactions_sync.v1")!(
      Buffer.from(JSON.stringify(page)),
      ctx({ sourceSchema: "plaid.transactions_sync.v1", sourceType: "plaid" }),
    );
    expect(out).not.toBeNull();
    expect(out!.parser).toBe("plaid_tx_v1");
    const extracted = out!.extracted as { accounts: unknown[]; transactions: unknown[] };
    expect(extracted.accounts).toHaveLength(1);
    // added + modified promoted; removed retained in raw only.
    expect(
      extracted.transactions.map((t) => (t as { transaction_id: string }).transaction_id),
    ).toEqual(["t1", "t2"]);
  });

  it("yields null for an empty plaid delta page", () => {
    const out = interpreterForSchema("plaid.transactions_sync.v1")!(
      Buffer.from(JSON.stringify({ added: [], modified: [], removed: [], next_cursor: "c" })),
      ctx({ sourceSchema: "plaid.transactions_sync.v1" }),
    );
    expect(out).toBeNull();
  });

  it("reshapes a stripe list page into the stripe_v1 payload with the account from context", () => {
    const page = {
      object: "list",
      data: [{ id: "txn_1", object: "balance_transaction", amount: -1250, currency: "usd" }],
      has_more: false,
    };
    const out = interpreterForSchema("stripe.balance_transactions.v1")!(
      Buffer.from(JSON.stringify(page)),
      ctx(),
    );
    expect(out!.parser).toBe("stripe_v1");
    expect(out!.extracted).toMatchObject({
      object_type: "balance_transaction",
      stripe_account_id: "acct_stripe1",
    });
    expect((out!.extracted as { objects: unknown[] }).objects).toHaveLength(1);
  });

  it("yields null for an empty stripe page", () => {
    const out = interpreterForSchema("stripe.charges.v1")!(
      Buffer.from(JSON.stringify({ object: "list", data: [], has_more: false })),
      ctx({ sourceSchema: "stripe.charges.v1" }),
    );
    expect(out).toBeNull();
  });

  it("throws on non-JSON bytes for a JSON schema", () => {
    expect(() =>
      interpreterForSchema("stripe.charges.v1")!(
        Buffer.from("%PDF-1.7 not json"),
        ctx({ sourceSchema: "stripe.charges.v1" }),
      ),
    ).toThrow(/not JSON/);
  });
});

describe("merge accounting interpreters", () => {
  it("reshapes a Merge list page into the merge_accounting_v1 payload with the integration", () => {
    const page = {
      next: "cur_2",
      results: [{ id: "inv_1", type: "ACCOUNTS_PAYABLE", modified_at: "2026-06-01T00:00:00Z" }],
    };
    const out = interpreterForSchema("merge_accounting.invoices.v1")!(
      Buffer.from(JSON.stringify(page)),
      ctx({
        sourceSchema: "merge_accounting.invoices.v1",
        sourceType: "merge_accounting",
        sourceRef: { merge_integration: "NetSuite" },
        objectType: "invoice",
      }),
    );
    expect(out!.parser).toBe("merge_accounting_v1");
    expect(out!.extracted).toMatchObject({ object_type: "invoice", merge_integration: "NetSuite" });
    expect((out!.extracted as { objects: unknown[] }).objects).toHaveLength(1);
  });

  it("registers all six Merge page schemas and yields null on empty pages", () => {
    const schemas = [
      "merge_accounting.gl_accounts.v1",
      "merge_accounting.journal_entries.v1",
      "merge_accounting.invoices.v1",
      "merge_accounting.contacts.v1",
      "merge_accounting.payments.v1",
      "merge_accounting.tax_rates.v1",
    ];
    expect(registeredSchemas()).toEqual(expect.arrayContaining(schemas));
    for (const schema of schemas) {
      const out = interpreterForSchema(schema)!(
        Buffer.from(JSON.stringify({ next: null, results: [] })),
        ctx({ sourceSchema: schema, sourceType: "merge_accounting" }),
      );
      expect(out).toBeNull();
    }
  });
});
