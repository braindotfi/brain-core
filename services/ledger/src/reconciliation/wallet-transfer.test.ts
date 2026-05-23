import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WalletTransferMatcher } from "./wallet-transfer.js";
import { fakePool, findQuery, makeDeps, makeInput } from "./harness.js";

// The outflow query JOINs ledger_accounts; the inbound query reads ledger_transactions.
const OUTFLOWS = "JOIN ledger_accounts";
const INBOUNDS = "WHERE direction = 'inflow'";

const OUT_AT = new Date("2026-02-15T12:00:00Z");

function outRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "txn_out",
    account_id: "acc_wallet",
    amount: "1.50000000",
    currency: "ETH",
    transaction_date: OUT_AT,
    ...over,
  };
}

function inRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "txn_in",
    account_id: "acc_exchange",
    amount: "1.50000000",
    currency: "ETH",
    transaction_date: OUT_AT,
    ...over,
  };
}

/** Build an inbound that lands `minutes` after the outflow. */
function inAt(minutes: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return inRow({ transaction_date: new Date(OUT_AT.getTime() + minutes * 60_000), ...over });
}

describe("WalletTransferMatcher — happy path", () => {
  it("matches an on-chain outflow to a near-simultaneous inbound of equal amount", async () => {
    const { pool } = fakePool({ [OUTFLOWS]: [outRow()], [INBOUNDS]: [inRow()] });
    const { deps, audit } = makeDeps(pool);
    const result = await new WalletTransferMatcher().run(deps, makeInput());

    expect(result.matchType).toBe("wallet_transfer");
    expect(result.matchesProduced).toHaveLength(1);
    const m = result.matchesProduced[0]!;
    expect(m.leftEntityId).toBe("txn_out");
    expect(m.rightEntityId).toBe("txn_in");
    expect(m.confidenceScore).toBeGreaterThanOrEqual(0.8);
    expect(audit.events).toHaveLength(1);
  });

  it("matches within the 5-minute tier", async () => {
    const { pool } = fakePool({ [OUTFLOWS]: [outRow()], [INBOUNDS]: [inAt(4)] });
    const { deps } = makeDeps(pool);
    const result = await new WalletTransferMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(1);
  });
});

describe("WalletTransferMatcher — time-window boundaries", () => {
  it("rejects an inbound just outside the 10-minute window (tScore=0 → continue)", async () => {
    const { pool } = fakePool({ [OUTFLOWS]: [outRow()], [INBOUNDS]: [inAt(11)] });
    const { deps } = makeDeps(pool);
    const result = await new WalletTransferMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("a 1-minute gap scores higher than a 9-minute gap", async () => {
    const near = await new WalletTransferMatcher().run(
      makeDeps(fakePool({ [OUTFLOWS]: [outRow()], [INBOUNDS]: [inAt(1)] }).pool).deps,
      makeInput(),
    );
    const far = await new WalletTransferMatcher().run(
      makeDeps(fakePool({ [OUTFLOWS]: [outRow()], [INBOUNDS]: [inAt(9)] }).pool).deps,
      makeInput(),
    );
    const nearScore = near.matchesProduced[0]?.confidenceScore ?? 0;
    const farScore = far.matchesProduced[0]?.confidenceScore ?? 0;
    expect(nearScore).toBeGreaterThan(farScore);
  });

  it("at 9 minutes the amount must agree (0.7 time tier alone can't clear 0.8)", async () => {
    // tScore=0.7 at 9 min; with a mismatched amount (score 0): 0.7*0 + 0.3*0.7 = 0.21 < 0.8
    const { pool } = fakePool({
      [OUTFLOWS]: [outRow()],
      [INBOUNDS]: [inAt(9, { amount: "5.00000000" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new WalletTransferMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });
});

describe("WalletTransferMatcher — no-match / edge paths", () => {
  it("scans zero when there are no on-chain outflows", async () => {
    const { pool } = fakePool({ [INBOUNDS]: [inRow()] });
    const { deps, audit } = makeDeps(pool);
    const result = await new WalletTransferMatcher().run(deps, makeInput());
    expect(result.candidatesScanned).toBe(0);
    expect(result.matchesProduced).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it("skips an inbound in a different currency", async () => {
    const { pool } = fakePool({
      [OUTFLOWS]: [outRow({ currency: "ETH" })],
      [INBOUNDS]: [inRow({ currency: "USDC" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new WalletTransferMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("picks the best inbound among several", async () => {
    const { pool } = fakePool({
      [OUTFLOWS]: [outRow()],
      [INBOUNDS]: [inAt(9, { id: "txn_in_far" }), inAt(0, { id: "txn_in_exact" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new WalletTransferMatcher().run(deps, makeInput());
    expect(result.matchesProduced[0]!.rightEntityId).toBe("txn_in_exact");
  });

  it("honors maxMatches", async () => {
    const { pool } = fakePool({
      [OUTFLOWS]: [outRow({ id: "out_a" }), outRow({ id: "out_b" })],
      [INBOUNDS]: [inRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new WalletTransferMatcher().run(deps, makeInput({ maxMatches: 1 }));
    expect(result.matchesProduced).toHaveLength(1);
  });

  it("does not re-push when persist reports the match already exists", async () => {
    const { pool } = fakePool({
      [OUTFLOWS]: [outRow()],
      [INBOUNDS]: [inRow()],
      "SELECT * FROM ledger_reconciliation_matches": [{ id: "rec_existing" }],
    });
    const { deps, audit } = makeDeps(pool);
    const result = await new WalletTransferMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it("defaults `since` when null is passed", async () => {
    const { pool, queries } = fakePool({ [OUTFLOWS]: [] });
    const { deps } = makeDeps(pool);
    await new WalletTransferMatcher().run(deps, makeInput({ since: null }));
    const q = findQuery(queries, OUTFLOWS);
    expect(q.values[0]).toBeInstanceOf(Date);
  });
});

describe("WalletTransferMatcher — property: time-score monotonicity", () => {
  it("a closer inbound never scores lower than a more distant one (same amount)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 10 }),
        async (m1, m2) => {
          const near = Math.min(m1, m2);
          const far = Math.max(m1, m2);
          const scoreAt = async (minutes: number): Promise<number> => {
            const { pool } = fakePool({ [OUTFLOWS]: [outRow()], [INBOUNDS]: [inAt(minutes)] });
            const r = await new WalletTransferMatcher().run(makeDeps(pool).deps, makeInput());
            return r.matchesProduced[0]?.confidenceScore ?? 0;
          };
          expect(await scoreAt(near)).toBeGreaterThanOrEqual(await scoreAt(far));
        },
      ),
    );
  });
});
