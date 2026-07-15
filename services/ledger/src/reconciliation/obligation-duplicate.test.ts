import { describe, expect, it } from "vitest";
import { ObligationDuplicateMatcher } from "./obligation-duplicate.js";
import { fakePool, findQuery, makeDeps, makeInput } from "./harness.js";

// Both loader queries hit ledger_obligations; route by the provenance filter.
const LOW_TRUST = "provenance IN ('agent_contributed','customer_asserted')";
const INDEPENDENT = "provenance IN ('extracted','human_confirmed')";

function docObservation(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "obl_doc",
    counterparty_id: "cpt_acme",
    amount_due: "1250.00",
    currency: "USD",
    due_date: new Date("2026-07-01T00:00:00Z"),
    direction: "payable",
    ...over,
  };
}

function billObservation(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "obl_bill",
    counterparty_id: "cpt_acme",
    amount_due: "1250.00",
    currency: "USD",
    due_date: new Date("2026-07-03T00:00:00Z"),
    direction: "payable",
    ...over,
  };
}

describe("ObligationDuplicateMatcher — confident resolution", () => {
  it("links a doc payable to the aggregator bill as `matched` when amount/date align", async () => {
    const { pool, queries } = fakePool({
      [LOW_TRUST]: [docObservation()],
      [INDEPENDENT]: [billObservation()],
    });
    const { deps, audit } = makeDeps(pool);
    const result = await new ObligationDuplicateMatcher().run(deps, makeInput());

    expect(result.matchType).toBe("obligation_duplicate");
    expect(result.matchesProduced).toHaveLength(1);
    expect(result.matchesProduced[0]!.confidenceScore).toBeGreaterThanOrEqual(0.8);

    const insert = findQuery(queries, "INSERT INTO ledger_reconciliation_matches")!;
    expect(insert.values).toContain("matched");
    expect(insert.values).toContain("obl_doc");
    expect(insert.values).toContain("obl_bill");
    // Observations linked, never merged: no UPDATE collapses either row.
    expect(audit.events.some((e) => e.action === "ledger.reconciliation.matched")).toBe(true);
  });
});

describe("ObligationDuplicateMatcher — material ambiguity defers to review", () => {
  it("records `duplicate_possible` (no lift) when the amounts diverge but dates align", async () => {
    const { pool, queries } = fakePool({
      [LOW_TRUST]: [docObservation()],
      // ~0.4% amount divergence: the 0.6 amount-score band -> candidate territory.
      [INDEPENDENT]: [billObservation({ amount_due: "1255.00" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new ObligationDuplicateMatcher().run(deps, makeInput());

    expect(result.matchesProduced).toHaveLength(1);
    const insert = findQuery(queries, "INSERT INTO ledger_reconciliation_matches")!;
    expect(insert.values).toContain("duplicate_possible");
    // The candidate promotes NOTHING: no obligation confidence UPDATE ran.
    expect(queries.some((q) => q.text.includes("UPDATE ledger_obligations"))).toBe(false);
  });

  it("produces nothing below the candidate threshold", async () => {
    const { pool, queries } = fakePool({
      [LOW_TRUST]: [docObservation()],
      [INDEPENDENT]: [billObservation({ amount_due: "2900.00" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new ObligationDuplicateMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
    expect(queries.some((q) => q.text.includes("INSERT INTO ledger_reconciliation_matches"))).toBe(
      false,
    );
  });

  it("does not link same-amount recurring obligations with different invoice identities", async () => {
    const { pool, queries } = fakePool({
      [LOW_TRUST]: [docObservation({ identity_key: "INV-1001" })],
      [INDEPENDENT]: [billObservation({ identity_key: "INV-1002" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new ObligationDuplicateMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
    expect(queries.some((q) => q.text.includes("INSERT INTO ledger_reconciliation_matches"))).toBe(
      false,
    );
  });
});

describe("ObligationDuplicateMatcher — scan filters", () => {
  it("scans zero when no low-trust obligations exist", async () => {
    const { pool } = fakePool({ [INDEPENDENT]: [billObservation()] });
    const { deps } = makeDeps(pool);
    const result = await new ObligationDuplicateMatcher().run(deps, makeInput());
    expect(result.candidatesScanned).toBe(0);
  });

  it("constrains the independent side to the resolved counterparty set/currency/direction and excludes self", async () => {
    const { pool, queries } = fakePool({
      [LOW_TRUST]: [docObservation()],
      [INDEPENDENT]: [],
    });
    const { deps } = makeDeps(pool);
    await new ObligationDuplicateMatcher().run(deps, makeInput());
    const q = findQuery(queries, INDEPENDENT)!;
    expect(q.text).toContain("id <> $1");
    // Candidate counterparties = the left's own id OR any linked by a confirmed
    // counterparty_duplicate match (link-don't-merge cross-source matching).
    expect(q.text).toContain("counterparty_id IN (");
    expect(q.text).toContain("SELECT $2::text");
    expect(q.text).toContain("match_type = 'counterparty_duplicate'");
    expect(q.text).toContain("status NOT IN ('paid','cancelled')");
    expect(q.text).toContain("currency = $3");
    expect(q.text).toContain("direction IS NOT DISTINCT FROM $4");
    expect(q.text).toContain("identity_key");
  });
});
