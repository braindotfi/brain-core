import { describe, expect, it } from "vitest";
import { CounterpartyDuplicateMatcher } from "./counterparty-duplicate.js";
import { fakePool, findQuery, makeDeps, makeInput } from "./harness.js";

const RECENT = "FROM ledger_counterparties\n        WHERE created_at";
const PEERS = "FROM ledger_counterparties peer";

function cp(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cp_a",
    name: "Acme Industrial Supply",
    normalized_name: "acme_industrial_supply",
    type: "merchant",
    provenance: "extracted",
    confidence: 0.7,
    metadata: {},
    created_at: new Date("2026-06-10T00:00:00Z"),
    ...over,
  };
}

describe("CounterpartyDuplicateMatcher — confident identity links", () => {
  it("links the Plaid merchant to the vendor record on exact normalized name", async () => {
    const { pool, queries } = fakePool({
      [RECENT]: [cp()],
      [PEERS]: [cp({ id: "cp_b", type: "vendor", provenance: "extracted", confidence: 0.8 })],
    });
    const { deps, audit } = makeDeps(pool);
    const result = await new CounterpartyDuplicateMatcher().run(deps, makeInput());

    expect(result.matchesProduced).toHaveLength(1);
    expect(result.matchesProduced[0]!.confidenceScore).toBeGreaterThanOrEqual(0.8);
    const insert = findQuery(queries, "INSERT INTO ledger_reconciliation_matches")!;
    expect(insert.values).toContain("counterparty_duplicate");
    expect(insert.values).toContain("matched");
    // Deterministic side ordering: cp_a < cp_b.
    expect(insert.values).toContain("cp_a");
    expect(insert.values).toContain("cp_b");
    expect(audit.events.some((e) => e.action === "ledger.reconciliation.matched")).toBe(true);
  });

  it("orders sides by id even when discovered in reverse", async () => {
    const { pool, queries } = fakePool({
      [RECENT]: [cp({ id: "cp_z", type: "vendor" })],
      [PEERS]: [cp({ id: "cp_a", type: "merchant" })],
    });
    const { deps } = makeDeps(pool);
    await new CounterpartyDuplicateMatcher().run(deps, makeInput());
    const insert = findQuery(queries, "INSERT INTO ledger_reconciliation_matches")!;
    const leftIdx = insert.values.indexOf("cp_a");
    const rightIdx = insert.values.indexOf("cp_z");
    expect(leftIdx).toBeGreaterThan(-1);
    expect(rightIdx).toBeGreaterThan(leftIdx); // left=min(id), right=max(id)
  });

  it("an email match in namespaced metadata boosts the score", async () => {
    const { pool } = fakePool({
      [RECENT]: [
        cp({ metadata: { stripe: { customer_id: "cus_1", email: "ap@globex.example" } } }),
      ],
      [PEERS]: [
        cp({
          id: "cp_b",
          type: "customer",
          metadata: { merge: { contact_id: "con_1", email: "AP@globex.example" } },
        }),
      ],
    });
    const { deps } = makeDeps(pool);
    const result = await new CounterpartyDuplicateMatcher().run(deps, makeInput());
    expect(result.matchesProduced[0]!.confidenceScore).toBeCloseTo(0.95, 5);
  });
});

describe("CounterpartyDuplicateMatcher — uncertainty defers to review", () => {
  it("loads prefix-blocked fuzzy peers and records duplicate_possible", async () => {
    const { pool, queries } = fakePool({
      [RECENT]: [cp()],
      [PEERS]: [
        cp({
          id: "cp_b",
          name: "Acme Industrial Supply LLC",
          normalized_name: "acme_industrial_supply_llc",
          type: "vendor",
        }),
      ],
    });
    const { deps } = makeDeps(pool);
    const result = await new CounterpartyDuplicateMatcher().run(deps, makeInput());

    expect(result.matchesProduced).toHaveLength(1);
    const peerQuery = findQuery(queries, PEERS)!;
    expect(peerQuery.text).toContain("LIKE $3");
    const insert = findQuery(queries, "INSERT INTO ledger_reconciliation_matches")!;
    expect(insert.values).toContain("duplicate_possible");
  });

  it("records nothing when no peer shares the normalized name", async () => {
    const { pool, queries } = fakePool({ [RECENT]: [cp()], [PEERS]: [] });
    const { deps } = makeDeps(pool);
    const result = await new CounterpartyDuplicateMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
    expect(queries.some((q) => q.text.includes("INSERT INTO ledger_reconciliation_matches"))).toBe(
      false,
    );
  });

  it("excludes already-linked pairs in the peer query (no duplicate links)", async () => {
    const { pool, queries } = fakePool({ [RECENT]: [cp()], [PEERS]: [] });
    const { deps } = makeDeps(pool);
    await new CounterpartyDuplicateMatcher().run(deps, makeInput());
    const q = findQuery(queries, PEERS)!;
    expect(q.text).toContain("LEAST($1, peer.id)");
    expect(q.text).toContain("GREATEST($1, peer.id)");
  });
});
