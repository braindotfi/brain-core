import { describe, expect, it } from "vitest";
import { AccountDuplicateMatcher } from "./account-duplicate.js";
import { fakePool, findQuery, makeDeps, makeInput } from "./harness.js";

const RECENT = "FROM ledger_accounts\n        WHERE created_at";
const PEERS = "FROM ledger_accounts peer";

function acct(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acct_a",
    name: "Operating Checking",
    institution: "Chase",
    account_type: "bank_checking",
    currency: "USD",
    created_at: new Date("2026-06-10T00:00:00Z"),
    ...over,
  };
}

describe("AccountDuplicateMatcher — candidate-only by design", () => {
  it("records a same-institution same-name pair as duplicate_possible, never matched", async () => {
    const { pool, queries } = fakePool({
      [RECENT]: [acct()],
      [PEERS]: [acct({ id: "acct_b", name: "Operating Checking" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new AccountDuplicateMatcher().run(deps, makeInput());

    expect(result.matchesProduced).toHaveLength(1);
    // Hard ceiling keeps every account link below the confident threshold.
    expect(result.matchesProduced[0]!.confidenceScore).toBeLessThan(0.8);
    const insert = findQuery(queries, "INSERT INTO ledger_reconciliation_matches")!;
    expect(insert.values).toContain("account_duplicate");
    expect(insert.values).toContain("duplicate_possible");
    expect(insert.values).not.toContain("matched");
    // Candidates never lift: no account row was updated.
    expect(queries.some((q) => q.text.includes("UPDATE ledger_accounts"))).toBe(false);
  });

  it("produces nothing when only the institution agrees (name dissimilar)", async () => {
    const { pool, queries } = fakePool({
      [RECENT]: [acct()],
      [PEERS]: [acct({ id: "acct_b", name: "Tax Reserve" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new AccountDuplicateMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
    expect(queries.some((q) => q.text.includes("INSERT INTO ledger_reconciliation_matches"))).toBe(
      false,
    );
  });

  it("gates peers on currency + account_type and excludes linked pairs", async () => {
    const { pool, queries } = fakePool({ [RECENT]: [acct()], [PEERS]: [] });
    const { deps } = makeDeps(pool);
    await new AccountDuplicateMatcher().run(deps, makeInput());
    const q = findQuery(queries, PEERS)!;
    expect(q.text).toContain("peer.currency = $2");
    expect(q.text).toContain("peer.account_type = $3");
    expect(q.text).toContain("LEAST($1, peer.id)");
  });
});
