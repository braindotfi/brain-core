import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SubscriptionChargeMatcher } from "./subscription-charge.js";
import { fakePool, findQuery, makeDeps, makeInput } from "./harness.js";

const OBLIGATIONS = "FROM ledger_obligations";
const TRANSACTIONS = "FROM ledger_transactions";

function oblRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "obl_sub_1",
    counterparty_id: "cpt_vendor",
    amount_due: "29.99",
    currency: "USD",
    due_date: new Date("2026-02-15T00:00:00Z"),
    ...over,
  };
}

function txRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "txn_1",
    counterparty_id: "cpt_vendor",
    amount: "29.99",
    currency: "USD",
    transaction_date: new Date("2026-02-15T00:00:00Z"),
    posted_date: new Date("2026-02-15T00:00:00Z"),
    ...over,
  };
}

describe("SubscriptionChargeMatcher — happy path", () => {
  it("matches a subscription obligation to an exact recurring charge", async () => {
    const { pool } = fakePool({ [OBLIGATIONS]: [oblRow()], [TRANSACTIONS]: [txRow()] });
    const { deps, audit } = makeDeps(pool);
    const result = await new SubscriptionChargeMatcher().run(deps, makeInput());

    expect(result.matchType).toBe("subscription_charge");
    expect(result.matchesProduced).toHaveLength(1);
    expect(result.matchesProduced[0]!.confidenceScore).toBeGreaterThanOrEqual(0.75);
    expect(audit.events).toHaveLength(1);
  });

  it("falls back to transaction_date when posted_date is null", async () => {
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow()],
      [TRANSACTIONS]: [txRow({ posted_date: null })],
    });
    const { deps } = makeDeps(pool);
    const result = await new SubscriptionChargeMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(1);
  });
});

describe("SubscriptionChargeMatcher — no-match / edge paths", () => {
  it("scans zero when there are no subscription obligations", async () => {
    const { pool } = fakePool({ [TRANSACTIONS]: [txRow()] });
    const { deps, audit } = makeDeps(pool);
    const result = await new SubscriptionChargeMatcher().run(deps, makeInput());
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
    const result = await new SubscriptionChargeMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("does not match when amount differs and counterparty differs (below 0.75)", async () => {
    // amount within 5% scores only 0.2 → 0.5*0.2 + 0.3*date(1) + 0.2*0 = 0.4 < 0.75
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow({ amount_due: "29.99" })],
      [TRANSACTIONS]: [txRow({ amount: "31.00", counterparty_id: "cpt_other" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new SubscriptionChargeMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("picks the highest-scoring candidate", async () => {
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow()],
      [TRANSACTIONS]: [
        txRow({ id: "txn_far", posted_date: new Date("2026-02-18T00:00:00Z") }),
        txRow({ id: "txn_exact" }),
      ],
    });
    const { deps } = makeDeps(pool);
    const result = await new SubscriptionChargeMatcher().run(deps, makeInput());
    expect(result.matchesProduced[0]!.rightEntityId).toBe("txn_exact");
  });

  it("honors maxMatches", async () => {
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow({ id: "obl_a" }), oblRow({ id: "obl_b" })],
      [TRANSACTIONS]: [txRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new SubscriptionChargeMatcher().run(deps, makeInput({ maxMatches: 1 }));
    expect(result.matchesProduced).toHaveLength(1);
  });

  it("does not re-push when persist reports the match already exists", async () => {
    const { pool } = fakePool({
      [OBLIGATIONS]: [oblRow()],
      [TRANSACTIONS]: [txRow()],
      "SELECT * FROM ledger_reconciliation_matches": [{ id: "rec_existing" }],
    });
    const { deps, audit } = makeDeps(pool);
    const result = await new SubscriptionChargeMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it("defaults `since` when null is passed", async () => {
    const { pool, queries } = fakePool({ [OBLIGATIONS]: [] });
    const { deps } = makeDeps(pool);
    await new SubscriptionChargeMatcher().run(deps, makeInput({ since: null }));
    const q = findQuery(queries, OBLIGATIONS);
    expect(q.values[0]).toBeInstanceOf(Date);
  });
});

describe("SubscriptionChargeMatcher — property: exact amount + same vendor always matches", () => {
  it("an exact-amount, same-day, same-counterparty charge clears the threshold", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 999999 }), async (cents) => {
        const amount = (cents / 100).toFixed(2);
        const { pool } = fakePool({
          [OBLIGATIONS]: [oblRow({ amount_due: amount })],
          [TRANSACTIONS]: [txRow({ amount })],
        });
        const r = await new SubscriptionChargeMatcher().run(makeDeps(pool).deps, makeInput());
        expect(r.matchesProduced).toHaveLength(1);
        expect(r.matchesProduced[0]!.confidenceScore).toBe(1);
      }),
    );
  });
});
