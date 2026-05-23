import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PayrollBankDebitMatcher } from "./payroll-bank-debit.js";
import { fakePool, findQuery, makeDeps, makeInput } from "./harness.js";

const OBLIGATIONS = "FROM ledger_obligations";
const TRANSACTIONS = "FROM ledger_transactions";

function oblRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "obl_pay_1",
    counterparty_id: "cpt_payroll",
    amount_due: "12000.00",
    currency: "USD",
    due_date: new Date("2026-02-15T00:00:00Z"),
    ...over,
  };
}

function txRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "txn_1",
    counterparty_id: "cpt_payroll",
    amount: "12000.00",
    currency: "USD",
    transaction_date: new Date("2026-02-15T00:00:00Z"),
    posted_date: new Date("2026-02-15T00:00:00Z"),
    ...over,
  };
}

describe("PayrollBankDebitMatcher — happy path", () => {
  it("matches a payroll obligation to a same-amount, same-counterparty outflow", async () => {
    const { pool } = fakePool({ [OBLIGATIONS]: [oblRow()], [TRANSACTIONS]: [txRow()] });
    const { deps, audit } = makeDeps(pool);
    const result = await new PayrollBankDebitMatcher().run(deps, makeInput());

    expect(result.matchType).toBe("payroll_bank_debit");
    expect(result.matchesProduced).toHaveLength(1);
    expect(result.matchesProduced[0]!.leftEntityId).toBe("obl_pay_1");
    expect(audit.events).toHaveLength(1);
  });

  it("matches when counterparty differs but amount+date carry it (cpt weight 0.15)", async () => {
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow()],
      [TRANSACTIONS]: [txRow({ counterparty_id: "cpt_other" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new PayrollBankDebitMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(1);
    expect(result.matchesProduced[0]!.confidenceScore).toBeLessThan(1);
  });

  it("falls back to transaction_date when posted_date is null", async () => {
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow()],
      [TRANSACTIONS]: [txRow({ posted_date: null })],
    });
    const { deps } = makeDeps(pool);
    const result = await new PayrollBankDebitMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(1);
  });
});

describe("PayrollBankDebitMatcher — no-match / edge paths", () => {
  it("scans zero when there are no payroll obligations", async () => {
    const { pool } = fakePool({ [TRANSACTIONS]: [txRow()] });
    const { deps, audit } = makeDeps(pool);
    const result = await new PayrollBankDebitMatcher().run(deps, makeInput());
    expect(result.candidatesScanned).toBe(0);
    expect(result.matchesProduced).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it("skips a different-currency transaction", async () => {
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow({ currency: "USD" })],
      [TRANSACTIONS]: [txRow({ currency: "EUR" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new PayrollBankDebitMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("produces no match when amount is off and counterparty differs", async () => {
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow()],
      [TRANSACTIONS]: [
        txRow({
          amount: "100.00",
          counterparty_id: "cpt_other",
          transaction_date: new Date("2026-02-25T00:00:00Z"),
          posted_date: new Date("2026-02-25T00:00:00Z"),
        }),
      ],
    });
    const { deps } = makeDeps(pool);
    const result = await new PayrollBankDebitMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("picks the strongest candidate", async () => {
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow()],
      [TRANSACTIONS]: [
        txRow({ id: "txn_weak", counterparty_id: "cpt_other", amount: "12050.00" }),
        txRow({ id: "txn_strong" }),
      ],
    });
    const { deps } = makeDeps(pool);
    const result = await new PayrollBankDebitMatcher().run(deps, makeInput());
    expect(result.matchesProduced[0]!.rightEntityId).toBe("txn_strong");
  });

  it("honors maxMatches", async () => {
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow({ id: "obl_a" }), oblRow({ id: "obl_b" })],
      [TRANSACTIONS]: [txRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new PayrollBankDebitMatcher().run(deps, makeInput({ maxMatches: 1 }));
    expect(result.matchesProduced).toHaveLength(1);
  });

  it("does not re-push when persist reports the match already exists", async () => {
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow()],
      [TRANSACTIONS]: [txRow()],
      "SELECT * FROM ledger_reconciliation_matches": [{ id: "rec_existing" }],
    });
    const { deps, audit } = makeDeps(pool);
    const result = await new PayrollBankDebitMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it("defaults `since` when null is passed", async () => {
    const { pool, queries } = fakePool({ [OBLIGATIONS]: [] });
    const { deps } = makeDeps(pool);
    await new PayrollBankDebitMatcher().run(deps, makeInput({ since: null }));
    const q = findQuery(queries, OBLIGATIONS);
    expect(q.values[0]).toBeInstanceOf(Date);
  });
});

describe("PayrollBankDebitMatcher — property: determinism", () => {
  it("identical inputs yield identical match counts and scores", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 999999 }),
        fc.boolean(),
        async (cents, sameCpt) => {
          const amount = (cents / 100).toFixed(2);
          const routes = {
            [OBLIGATIONS]: [oblRow({ amount_due: amount })],
            [TRANSACTIONS]: [
              txRow({ amount, counterparty_id: sameCpt ? "cpt_payroll" : "cpt_other" }),
            ],
          };
          const a = await new PayrollBankDebitMatcher().run(
            makeDeps(fakePool(routes).pool).deps,
            makeInput(),
          );
          const b = await new PayrollBankDebitMatcher().run(
            makeDeps(fakePool(routes).pool).deps,
            makeInput(),
          );
          expect(a.matchesProduced.length).toBe(b.matchesProduced.length);
          expect(a.matchesProduced[0]?.confidenceScore).toBe(b.matchesProduced[0]?.confidenceScore);
        },
      ),
    );
  });
});
