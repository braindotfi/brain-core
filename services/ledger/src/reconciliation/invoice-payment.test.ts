import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvoicePaymentMatcher } from "./invoice-payment.js";
import { fakePool, findQuery, makeDeps, makeInput } from "./harness.js";

const INVOICES = "FROM ledger_invoices";
const TRANSACTIONS = "FROM ledger_transactions";

function invRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "inv_1",
    counterparty_id: "cpt_1",
    amount_due: "500.00",
    amount_paid: "0.00",
    currency: "USD",
    issue_date: new Date("2026-02-01T00:00:00Z"),
    due_date: new Date("2026-02-15T00:00:00Z"),
    status: "sent",
    ...over,
  };
}

function txRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "txn_1",
    counterparty_id: "cpt_1",
    amount: "500.00",
    currency: "USD",
    direction: "inflow",
    transaction_date: new Date("2026-02-15T00:00:00Z"),
    posted_date: new Date("2026-02-15T00:00:00Z"),
    reconciliation_status: null,
    ...over,
  };
}

describe("InvoicePaymentMatcher — happy path", () => {
  it("matches an invoice to a same-amount, same-counterparty transaction", async () => {
    const { pool } = fakePool({ [INVOICES]: [invRow()], [TRANSACTIONS]: [txRow()] });
    const { deps, audit } = makeDeps(pool);
    const result = await new InvoicePaymentMatcher().run(deps, makeInput());

    expect(result.matchType).toBe("invoice_payment");
    expect(result.matchesProduced).toHaveLength(1);
    const m = result.matchesProduced[0]!;
    expect(m.leftEntityType).toBe("invoice");
    expect(m.rightEntityType).toBe("transaction");
    expect(audit.events).toHaveLength(1);
  });

  it("falls back to issue_date when due_date is null", async () => {
    const { pool } = fakePool({
      [INVOICES]: [invRow({ due_date: null })],
      [TRANSACTIONS]: [
        txRow({ transaction_date: new Date("2026-02-01T00:00:00Z"), posted_date: null }),
      ],
    });
    const { deps } = makeDeps(pool);
    const result = await new InvoicePaymentMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(1);
  });

  it("matches even when counterparty differs, if amount+date carry it over threshold", async () => {
    // counterparty weight is only 0.15; an exact amount + same-day date still clears 0.7.
    const { pool } = fakePool({
      [INVOICES]: [invRow()],
      [TRANSACTIONS]: [txRow({ counterparty_id: "cpt_other" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new InvoicePaymentMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(1);
    expect(result.matchesProduced[0]!.confidenceScore).toBeLessThan(1);
  });
});

describe("InvoicePaymentMatcher — no-match / edge paths", () => {
  it("scans zero when no open invoices exist", async () => {
    const { pool } = fakePool({ [TRANSACTIONS]: [txRow()] });
    const { deps, audit } = makeDeps(pool);
    const result = await new InvoicePaymentMatcher().run(deps, makeInput());
    expect(result.candidatesScanned).toBe(0);
    expect(result.matchesProduced).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it("skips a different-currency transaction", async () => {
    const { pool } = fakePool({
      [INVOICES]: [invRow({ currency: "USD" })],
      [TRANSACTIONS]: [txRow({ currency: "GBP" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new InvoicePaymentMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("produces no match below threshold (wrong amount, far date, wrong cpt)", async () => {
    const { pool } = fakePool({
      [INVOICES]: [invRow()],
      [TRANSACTIONS]: [
        txRow({
          amount: "9000.00",
          counterparty_id: "cpt_other",
          transaction_date: new Date("2026-03-01T00:00:00Z"),
          posted_date: new Date("2026-03-01T00:00:00Z"),
        }),
      ],
    });
    const { deps } = makeDeps(pool);
    const result = await new InvoicePaymentMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("prefers the highest-scoring candidate", async () => {
    const { pool } = fakePool({
      [INVOICES]: [invRow()],
      [TRANSACTIONS]: [
        txRow({ id: "txn_weak", amount: "505.00", counterparty_id: "cpt_other" }),
        txRow({ id: "txn_strong" }),
      ],
    });
    const { deps } = makeDeps(pool);
    const result = await new InvoicePaymentMatcher().run(deps, makeInput());
    expect(result.matchesProduced[0]!.rightEntityId).toBe("txn_strong");
  });

  it("honors maxMatches", async () => {
    const { pool } = fakePool({
      [INVOICES]: [invRow({ id: "inv_a" }), invRow({ id: "inv_b" })],
      [TRANSACTIONS]: [txRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new InvoicePaymentMatcher().run(deps, makeInput({ maxMatches: 1 }));
    expect(result.matchesProduced).toHaveLength(1);
  });

  it("does not re-push an already-persisted match", async () => {
    const { pool } = fakePool({
      [INVOICES]: [invRow()],
      [TRANSACTIONS]: [txRow()],
      "SELECT * FROM ledger_reconciliation_matches": [{ id: "rec_existing" }],
    });
    const { deps, audit } = makeDeps(pool);
    const result = await new InvoicePaymentMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it("defaults `since` when null is passed", async () => {
    const { pool, queries } = fakePool({ [INVOICES]: [] });
    const { deps } = makeDeps(pool);
    await new InvoicePaymentMatcher().run(deps, makeInput({ since: null }));
    const q = findQuery(queries, INVOICES);
    expect(q.values[0]).toBeInstanceOf(Date);
  });
});

describe("InvoicePaymentMatcher — property: amount tolerance monotonicity", () => {
  it("score is non-increasing as the transaction amount drifts from the invoice", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 50, max: 500 }),
        async (smallDriftCents, bigDriftCents) => {
          fc.pre(bigDriftCents > smallDriftCents);
          const base = 50000; // $500.00 in cents
          const near = ((base + smallDriftCents) / 100).toFixed(2);
          const far = ((base + bigDriftCents) / 100).toFixed(2);

          const scoreFor = async (amount: string): Promise<number> => {
            const { pool } = fakePool({
              [INVOICES]: [invRow()],
              [TRANSACTIONS]: [txRow({ amount })],
            });
            const r = await new InvoicePaymentMatcher().run(makeDeps(pool).deps, makeInput());
            return r.matchesProduced[0]?.confidenceScore ?? 0;
          };

          const nearScore = await scoreFor(near);
          const farScore = await scoreFor(far);
          expect(nearScore).toBeGreaterThanOrEqual(farScore);
        },
      ),
    );
  });
});
