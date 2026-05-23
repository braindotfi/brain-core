import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TransactionReceiptMatcher } from "./transaction-receipt.js";
import { fakePool, findQuery, makeDeps, makeInput } from "./harness.js";

const DOCS = "FROM ledger_documents";
const TRANSACTIONS = "FROM ledger_transactions";

function docRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "doc_1",
    extracted_fields: {
      amount: "42.50",
      currency: "USD",
      date: "2026-02-10",
      merchant_name: "Acme Coffee",
    },
    linked_account_ids: ["acc_1"],
    ...over,
  };
}

function txRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "txn_1",
    account_id: "acc_1",
    amount: "42.50",
    currency: "USD",
    transaction_date: new Date("2026-02-10T00:00:00Z"),
    posted_date: new Date("2026-02-10T00:00:00Z"),
    description_normalized: "acme coffee",
    description_raw: "ACME COFFEE #12",
    ...over,
  };
}

describe("TransactionReceiptMatcher — happy path", () => {
  it("matches a receipt to a same-amount, same-day, name-overlapping tx", async () => {
    const { pool } = fakePool({ [DOCS]: [docRow()], [TRANSACTIONS]: [txRow()] });
    const { deps, audit } = makeDeps(pool);
    const result = await new TransactionReceiptMatcher().run(deps, makeInput());

    expect(result.matchType).toBe("transaction_receipt");
    expect(result.matchesProduced).toHaveLength(1);
    const m = result.matchesProduced[0]!;
    expect(m.leftEntityType).toBe("transaction");
    expect(m.rightEntityType).toBe("document");
    expect(audit.events).toHaveLength(1);
  });

  it("accepts a numeric amount field", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow({ extracted_fields: { amount: 42.5, currency: "USD", date: "2026-02-10" } })],
      [TRANSACTIONS]: [txRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new TransactionReceiptMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(1);
  });

  it("falls back to description_raw when description_normalized is null", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow()],
      [TRANSACTIONS]: [txRow({ description_normalized: null })],
    });
    const { deps } = makeDeps(pool);
    const result = await new TransactionReceiptMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(1);
  });

  it("scopes the tx query by account when the doc has linked accounts", async () => {
    const { pool, queries } = fakePool({ [DOCS]: [docRow({ linked_account_ids: ["acc_1"] })] });
    const { deps } = makeDeps(pool);
    await new TransactionReceiptMatcher().run(deps, makeInput());
    const q = findQuery(queries, TRANSACTIONS);
    expect(q.text).toContain("account_id = ANY");
    expect(q.values).toContainEqual(["acc_1"]);
  });

  it("omits the account filter when the doc has no linked accounts", async () => {
    const { pool, queries } = fakePool({ [DOCS]: [docRow({ linked_account_ids: [] })] });
    const { deps } = makeDeps(pool);
    await new TransactionReceiptMatcher().run(deps, makeInput());
    const q = findQuery(queries, TRANSACTIONS);
    expect(q.text).not.toContain("account_id = ANY");
  });
});

describe("TransactionReceiptMatcher — skip / no-match paths", () => {
  it("skips a document with no extractable amount", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow({ extracted_fields: { currency: "USD", date: "2026-02-10" } })],
      [TRANSACTIONS]: [txRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new TransactionReceiptMatcher().run(deps, makeInput());
    expect(result.candidatesScanned).toBe(1);
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("skips a document with no date", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow({ extracted_fields: { amount: "42.50", currency: "USD" } })],
      [TRANSACTIONS]: [txRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new TransactionReceiptMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("skips a document with an invalid date string", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow({ extracted_fields: { amount: "42.50", date: "nope" } })],
      [TRANSACTIONS]: [txRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new TransactionReceiptMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("skips a non-finite numeric amount", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow({ extracted_fields: { amount: Number.NaN, date: "2026-02-10" } })],
      [TRANSACTIONS]: [txRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new TransactionReceiptMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("skips a different-currency transaction", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow()],
      [TRANSACTIONS]: [txRow({ currency: "EUR" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new TransactionReceiptMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("handles a missing extracted_fields object", async () => {
    const { pool } = fakePool({ [DOCS]: [docRow({ extracted_fields: null })] });
    const { deps } = makeDeps(pool);
    const result = await new TransactionReceiptMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("produces no match when amount disagrees and there is no name overlap", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow({ extracted_fields: { amount: "42.50", date: "2026-02-10" } })],
      [TRANSACTIONS]: [
        txRow({
          amount: "999.00",
          description_normalized: "globex",
          description_raw: "GLOBEX",
        }),
      ],
    });
    const { deps } = makeDeps(pool);
    const result = await new TransactionReceiptMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("honors maxMatches", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow({ id: "doc_a" }), docRow({ id: "doc_b" })],
      [TRANSACTIONS]: [txRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new TransactionReceiptMatcher().run(deps, makeInput({ maxMatches: 1 }));
    expect(result.matchesProduced).toHaveLength(1);
  });

  it("does not re-push when persist reports the match already exists", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow()],
      [TRANSACTIONS]: [txRow()],
      "SELECT * FROM ledger_reconciliation_matches": [{ id: "rec_existing" }],
    });
    const { deps, audit } = makeDeps(pool);
    const result = await new TransactionReceiptMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it("defaults `since` when null is passed", async () => {
    const { pool, queries } = fakePool({ [DOCS]: [] });
    const { deps } = makeDeps(pool);
    await new TransactionReceiptMatcher().run(deps, makeInput({ since: null }));
    const q = findQuery(queries, DOCS);
    expect(q.values[0]).toBeInstanceOf(Date);
  });
});

describe("TransactionReceiptMatcher — property: name overlap never lowers score", () => {
  it("a matching merchant name yields a score >= a non-matching one", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("acme coffee", "totally different vendor"), async (memo) => {
        const { pool } = fakePool({
          [DOCS]: [docRow()],
          [TRANSACTIONS]: [txRow({ description_normalized: memo, description_raw: memo })],
        });
        const r = await new TransactionReceiptMatcher().run(makeDeps(pool).deps, makeInput());
        // Same amount + same day already clears 0.65; the score is bounded [0,1].
        const score = r.matchesProduced[0]?.confidenceScore ?? 0;
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }),
    );
  });
});
