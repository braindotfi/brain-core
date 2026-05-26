import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { OnchainSettlementMatcher } from "./onchain-settlement.js";
import { fakePool, findQuery, makeDeps, makeInput } from "./harness.js";

// The settlement query JOINs ledger_accounts; the obligation query reads ledger_obligations.
const SETTLEMENTS = "JOIN ledger_accounts";
const OBLIGATIONS = "FROM ledger_obligations";
const MATCHES = "ledger_reconciliation_matches";

const AT = new Date("2026-03-10T12:00:00Z");

function stlRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "txn_stl",
    counterparty_id: "cp_1",
    amount: "100.00000000",
    currency: "USD",
    transaction_date: AT,
    ...over,
  };
}

function oblRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "obl_1",
    counterparty_id: "cp_1",
    amount_due: "100.00000000",
    currency: "USD",
    due_date: AT,
    ...over,
  };
}

describe("OnchainSettlementMatcher — happy path", () => {
  it("matches an on-chain outflow to a same-counterparty obligation of equal amount", async () => {
    const { pool } = fakePool({ [SETTLEMENTS]: [stlRow()], [OBLIGATIONS]: [oblRow()] });
    const { deps, audit } = makeDeps(pool);
    const result = await new OnchainSettlementMatcher().run(deps, makeInput());

    expect(result.matchType).toBe("onchain_settlement");
    expect(result.matchesProduced).toHaveLength(1);
    const m = result.matchesProduced[0]!;
    expect(m.leftEntityType).toBe("transaction");
    expect(m.leftEntityId).toBe("txn_stl");
    expect(m.rightEntityType).toBe("obligation");
    expect(m.rightEntityId).toBe("obl_1");
    expect(m.confidenceScore).toBeGreaterThanOrEqual(0.8);
    expect(audit.events).toHaveLength(1);
  });

  it("picks the best obligation among several", async () => {
    const { pool } = fakePool({
      [SETTLEMENTS]: [stlRow()],
      [OBLIGATIONS]: [
        oblRow({ id: "obl_far", amount_due: "90.00000000" }),
        oblRow({ id: "obl_exact" }),
      ],
    });
    const { deps } = makeDeps(pool);
    const result = await new OnchainSettlementMatcher().run(deps, makeInput());
    expect(result.matchesProduced[0]!.rightEntityId).toBe("obl_exact");
  });
});

describe("OnchainSettlementMatcher — no-match / edge paths", () => {
  it("scans zero when there are no on-chain settlements", async () => {
    const { pool } = fakePool({ [OBLIGATIONS]: [oblRow()] });
    const { deps, audit } = makeDeps(pool);
    const result = await new OnchainSettlementMatcher().run(deps, makeInput());
    expect(result.candidatesScanned).toBe(0);
    expect(result.matchesProduced).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it("skips a settlement with no counterparty (cannot correlate)", async () => {
    const { pool } = fakePool({
      [SETTLEMENTS]: [stlRow({ counterparty_id: null })],
      [OBLIGATIONS]: [oblRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new OnchainSettlementMatcher().run(deps, makeInput());
    expect(result.candidatesScanned).toBe(1);
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("skips an obligation in a different currency", async () => {
    const { pool } = fakePool({
      [SETTLEMENTS]: [stlRow({ currency: "USD" })],
      [OBLIGATIONS]: [oblRow({ currency: "EUR" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new OnchainSettlementMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("rejects a mismatched amount (below threshold)", async () => {
    const { pool } = fakePool({
      [SETTLEMENTS]: [stlRow()],
      [OBLIGATIONS]: [oblRow({ amount_due: "5.00000000" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new OnchainSettlementMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("a different-counterparty obligation scores lower than a same-counterparty one", async () => {
    const same = await new OnchainSettlementMatcher().run(
      makeDeps(fakePool({ [SETTLEMENTS]: [stlRow()], [OBLIGATIONS]: [oblRow()] }).pool).deps,
      makeInput(),
    );
    const diff = await new OnchainSettlementMatcher().run(
      makeDeps(
        fakePool({
          [SETTLEMENTS]: [stlRow()],
          [OBLIGATIONS]: [oblRow({ counterparty_id: "cp_other" })],
        }).pool,
      ).deps,
      makeInput(),
    );
    const sameScore = same.matchesProduced[0]?.confidenceScore ?? 0;
    const diffScore = diff.matchesProduced[0]?.confidenceScore ?? 0;
    expect(sameScore).toBeGreaterThan(diffScore);
  });

  it("honors maxMatches", async () => {
    const { pool } = fakePool({
      [SETTLEMENTS]: [stlRow({ id: "stl_a" }), stlRow({ id: "stl_b" })],
      [OBLIGATIONS]: [oblRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new OnchainSettlementMatcher().run(deps, makeInput({ maxMatches: 1 }));
    expect(result.matchesProduced).toHaveLength(1);
  });

  it("does not re-push when persist reports the match already exists", async () => {
    const { pool } = fakePool({
      [SETTLEMENTS]: [stlRow()],
      [OBLIGATIONS]: [oblRow()],
      [`SELECT * FROM ${MATCHES}`]: [{ id: "rec_existing" }],
    });
    const { deps, audit } = makeDeps(pool);
    const result = await new OnchainSettlementMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it("defaults `since` when null is passed", async () => {
    const { pool, queries } = fakePool({ [SETTLEMENTS]: [] });
    const { deps } = makeDeps(pool);
    await new OnchainSettlementMatcher().run(deps, makeInput({ since: null }));
    const q = findQuery(queries, SETTLEMENTS);
    expect(q.values[0]).toBeInstanceOf(Date);
  });
});

describe("OnchainSettlementMatcher — property: amount-score monotonicity", () => {
  it("an obligation closer in amount never scores lower than a more distant one", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 40 }),
        async (d1, d2) => {
          const near = Math.min(d1, d2);
          const far = Math.max(d1, d2);
          const scoreAtDelta = async (delta: number): Promise<number> => {
            const { pool } = fakePool({
              [SETTLEMENTS]: [stlRow()],
              [OBLIGATIONS]: [oblRow({ amount_due: (100 - delta).toFixed(8) })],
            });
            const r = await new OnchainSettlementMatcher().run(makeDeps(pool).deps, makeInput());
            return r.matchesProduced[0]?.confidenceScore ?? 0;
          };
          expect(await scoreAtDelta(near)).toBeGreaterThanOrEqual(await scoreAtDelta(far));
        },
      ),
    );
  });
});
