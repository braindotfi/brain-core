import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CardChargeMatcher, DATE_WINDOW_DAYS } from "./card-charge.js";
import { fakePool, findQuery, makeDeps, makeInput } from "./harness.js";

const OBLIGATIONS = "FROM ledger_obligations";
const TRANSACTIONS = "FROM ledger_transactions";

function oblRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "obl_card_1",
    counterparty_id: "cpt_1",
    amount_due: "1000.00",
    minimum_due: "35.00",
    currency: "USD",
    due_date: new Date("2026-02-15T00:00:00Z"),
    ...over,
  };
}

function txRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "txn_1",
    counterparty_id: "cpt_1",
    amount: "1000.00",
    currency: "USD",
    transaction_date: new Date("2026-02-15T00:00:00Z"),
    posted_date: new Date("2026-02-15T00:00:00Z"),
    ...over,
  };
}

describe("CardChargeMatcher — happy path", () => {
  it("matches a card statement to a same-amount, same-day outflow", async () => {
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow()],
      [TRANSACTIONS]: [txRow()],
    });
    const { deps, audit } = makeDeps(pool);
    const result = await new CardChargeMatcher().run(deps, makeInput());

    expect(result.matchType).toBe("card_charge");
    expect(result.candidatesScanned).toBe(1);
    expect(result.matchesProduced).toHaveLength(1);
    const m = result.matchesProduced[0]!;
    expect(m.leftEntityId).toBe("obl_card_1");
    expect(m.rightEntityId).toBe("txn_1");
    expect(m.confidenceScore).toBeGreaterThanOrEqual(0.7);
    // persist.ts emits one audit event per created match.
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]!.action).toBe("ledger.reconciliation.matched");
  });

  it("matches against minimum_due when the full balance does not agree", async () => {
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow({ amount_due: "5000.00", minimum_due: "100.00" })],
      [TRANSACTIONS]: [txRow({ amount: "100.00" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new CardChargeMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(1);
  });

  it("picks the higher-scoring candidate when several qualify", async () => {
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow()],
      [TRANSACTIONS]: [
        txRow({ id: "txn_far", posted_date: new Date("2026-02-19T00:00:00Z") }),
        txRow({ id: "txn_exact" }),
      ],
    });
    const { deps } = makeDeps(pool);
    const result = await new CardChargeMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(1);
    expect(result.matchesProduced[0]!.rightEntityId).toBe("txn_exact");
  });
});

describe("CardChargeMatcher — no match / edge paths", () => {
  it("produces no match when no obligations exist", async () => {
    const { pool } = fakePool({ [TRANSACTIONS]: [txRow()] });
    const { deps, audit } = makeDeps(pool);
    const result = await new CardChargeMatcher().run(deps, makeInput());
    expect(result.candidatesScanned).toBe(0);
    expect(result.matchesProduced).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it("skips candidates in a different currency", async () => {
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow({ currency: "USD" })],
      [TRANSACTIONS]: [txRow({ currency: "EUR" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new CardChargeMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("produces no match when amount and date are both far off (below threshold)", async () => {
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow({ amount_due: "1000.00", minimum_due: null })],
      [TRANSACTIONS]: [txRow({ amount: "10.00", posted_date: new Date("2026-02-25T00:00:00Z") })],
    });
    const { deps } = makeDeps(pool);
    const result = await new CardChargeMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("falls back to transaction_date when posted_date is null", async () => {
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow()],
      [TRANSACTIONS]: [txRow({ posted_date: null })],
    });
    const { deps } = makeDeps(pool);
    const result = await new CardChargeMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(1);
  });

  it("honors maxMatches and stops scanning", async () => {
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow({ id: "obl_a" }), oblRow({ id: "obl_b" })],
      [TRANSACTIONS]: [txRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new CardChargeMatcher().run(deps, makeInput({ maxMatches: 1 }));
    expect(result.matchesProduced).toHaveLength(1);
  });

  it("does not re-push when persist reports the match already exists", async () => {
    // A pre-existing reconciliation_matches row makes findExistingMatch return it,
    // so persist.created === false and the matcher must not double-count.
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow()],
      [TRANSACTIONS]: [txRow()],
      "SELECT * FROM ledger_reconciliation_matches": [{ id: "rec_existing" }],
    });
    const { deps, audit } = makeDeps(pool);
    const result = await new CardChargeMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it("defaults `since` to a recent window when null is passed", async () => {
    const { pool, queries } = fakePool({ [OBLIGATIONS]: [] });
    const { deps } = makeDeps(pool);
    await new CardChargeMatcher().run(deps, makeInput({ since: null }));
    const q = findQuery(queries, OBLIGATIONS);
    const since = q.values[0] as Date;
    expect(since).toBeInstanceOf(Date);
    expect(since.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("CardChargeMatcher — DATE_WINDOW_DAYS SQL/scorer lock", () => {
  it("derives the SQL interval bound from DATE_WINDOW_DAYS (no hardcoded literal)", async () => {
    const { pool, queries } = fakePool({ [OBLIGATIONS]: [oblRow()], [TRANSACTIONS]: [] });
    const { deps } = makeDeps(pool);
    await new CardChargeMatcher().run(deps, makeInput());
    const q = findQuery(queries, TRANSACTIONS);
    // The interval is bound as a parameter built straight from the constant —
    // changing DATE_WINDOW_DAYS automatically moves the SQL pre-filter with it.
    expect(q.values).toContain(`${DATE_WINDOW_DAYS} days`);
    expect(q.text).not.toMatch(/INTERVAL '\d+ days'/);
  });
});

describe("CardChargeMatcher — property: determinism", () => {
  it("is deterministic for the same canned inputs", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 9999 }),
        fc.integer({ min: -3, max: 3 }),
        async (amountCents, dayShift) => {
          const amount = (amountCents / 100).toFixed(2);
          const due = new Date("2026-02-15T00:00:00Z");
          const posted = new Date(due.getTime() + dayShift * 24 * 60 * 60 * 1000);
          const routes = {
            [OBLIGATIONS]: [oblRow({ amount_due: amount, minimum_due: null })],
            [TRANSACTIONS]: [txRow({ amount, posted_date: posted })],
          };
          const a = await new CardChargeMatcher().run(
            makeDeps(fakePool(routes).pool).deps,
            makeInput(),
          );
          const b = await new CardChargeMatcher().run(
            makeDeps(fakePool(routes).pool).deps,
            makeInput(),
          );
          expect(a.matchesProduced.length).toBe(b.matchesProduced.length);
          if (a.matchesProduced.length === 1) {
            expect(a.matchesProduced[0]!.confidenceScore).toBe(
              b.matchesProduced[0]!.confidenceScore,
            );
          }
        },
      ),
    );
  });
});
