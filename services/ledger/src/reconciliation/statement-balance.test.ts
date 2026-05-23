import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DATE_WINDOW_DAYS, StatementBalanceMatcher } from "./statement-balance.js";
import { fakePool, findQuery, makeDeps, makeInput } from "./harness.js";

const DOCS = "FROM ledger_documents";
const BALANCES = "FROM ledger_balances";

function docRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "doc_1",
    linked_account_ids: ["acc_1"],
    extracted_fields: {
      balance: "2500.00",
      currency: "USD",
      statement_date: "2026-02-10",
    },
    created_at: new Date("2026-02-11T00:00:00Z"),
    ...over,
  };
}

function balRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "bal_1",
    account_id: "acc_1",
    current_balance: "2500.00",
    currency: "USD",
    as_of: new Date("2026-02-10T00:00:00Z"),
    ...over,
  };
}

describe("StatementBalanceMatcher — happy path", () => {
  it("matches a bank statement to a same-amount nearby balance", async () => {
    const { pool } = fakePool({ [DOCS]: [docRow()], [BALANCES]: [balRow()] });
    const { deps, audit } = makeDeps(pool);
    const result = await new StatementBalanceMatcher().run(deps, makeInput());

    expect(result.matchType).toBe("statement_balance");
    expect(result.matchesProduced).toHaveLength(1);
    const m = result.matchesProduced[0]!;
    expect(m.leftEntityType).toBe("document");
    expect(m.rightEntityType).toBe("balance");
    expect(m.confidenceScore).toBeGreaterThanOrEqual(0.75);
    expect(audit.events).toHaveLength(1);
  });

  it("uses `as_of` field when `statement_date` is absent", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow({ extracted_fields: { balance: "2500.00", as_of: "2026-02-10" } })],
      [BALANCES]: [balRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new StatementBalanceMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(1);
  });

  it("accepts a numeric balance field (coerced to 2dp string)", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow({ extracted_fields: { balance: 2500, statement_date: "2026-02-10" } })],
      [BALANCES]: [balRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new StatementBalanceMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(1);
  });

  it("defaults currency to USD when extracted_fields omits it", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow({ extracted_fields: { balance: "2500.00", statement_date: "2026-02-10" } })],
      [BALANCES]: [balRow({ currency: "USD" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new StatementBalanceMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(1);
  });
});

describe("StatementBalanceMatcher — skip / no-match paths", () => {
  it("skips a document with an unparseable balance", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow({ extracted_fields: { balance: "n/a", statement_date: "2026-02-10" } })],
      [BALANCES]: [balRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new StatementBalanceMatcher().run(deps, makeInput());
    expect(result.candidatesScanned).toBe(1);
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("skips a document with a non-finite numeric balance", async () => {
    const { pool } = fakePool({
      [DOCS]: [
        docRow({
          extracted_fields: { balance: Number.POSITIVE_INFINITY, statement_date: "2026-02-10" },
        }),
      ],
      [BALANCES]: [balRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new StatementBalanceMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("skips a document with no date field", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow({ extracted_fields: { balance: "2500.00" } })],
      [BALANCES]: [balRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new StatementBalanceMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("skips a document whose date string is invalid", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow({ extracted_fields: { balance: "2500.00", statement_date: "not-a-date" } })],
      [BALANCES]: [balRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new StatementBalanceMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("skips a document with no linked accounts", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow({ linked_account_ids: [] })],
      [BALANCES]: [balRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new StatementBalanceMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("skips balances in a different currency", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow()],
      [BALANCES]: [balRow({ currency: "EUR" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new StatementBalanceMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("produces no match when the balance disagrees beyond tolerance", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow({ extracted_fields: { balance: "2500.00", statement_date: "2026-02-10" } })],
      [BALANCES]: [balRow({ current_balance: "9999.00" })],
    });
    const { deps } = makeDeps(pool);
    const result = await new StatementBalanceMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("handles a missing extracted_fields object", async () => {
    const { pool } = fakePool({ [DOCS]: [docRow({ extracted_fields: null })], [BALANCES]: [] });
    const { deps } = makeDeps(pool);
    const result = await new StatementBalanceMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
  });

  it("honors maxMatches", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow({ id: "doc_a" }), docRow({ id: "doc_b" })],
      [BALANCES]: [balRow()],
    });
    const { deps } = makeDeps(pool);
    const result = await new StatementBalanceMatcher().run(deps, makeInput({ maxMatches: 1 }));
    expect(result.matchesProduced).toHaveLength(1);
  });

  it("does not re-push when persist reports the match already exists", async () => {
    const { pool } = fakePool({
      [DOCS]: [docRow()],
      [BALANCES]: [balRow()],
      "SELECT * FROM ledger_reconciliation_matches": [{ id: "rec_existing" }],
    });
    const { deps, audit } = makeDeps(pool);
    const result = await new StatementBalanceMatcher().run(deps, makeInput());
    expect(result.matchesProduced).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it("defaults `since` when null is passed", async () => {
    const { pool, queries } = fakePool({ [DOCS]: [] });
    const { deps } = makeDeps(pool);
    await new StatementBalanceMatcher().run(deps, makeInput({ since: null }));
    const q = findQuery(queries, DOCS);
    expect(q.values[0]).toBeInstanceOf(Date);
  });
});

describe("StatementBalanceMatcher — DATE_WINDOW_DAYS SQL/scorer lock", () => {
  it("derives the SQL balance-window interval from DATE_WINDOW_DAYS", async () => {
    const { pool, queries } = fakePool({ [DOCS]: [docRow()], [BALANCES]: [] });
    const { deps } = makeDeps(pool);
    await new StatementBalanceMatcher().run(deps, makeInput());
    const q = findQuery(queries, BALANCES);
    expect(q.values).toContain(`${DATE_WINDOW_DAYS} days`);
    expect(q.text).not.toMatch(/INTERVAL '\d+ days'/);
  });
});

describe("StatementBalanceMatcher — property: determinism", () => {
  it("produces the same outcome for identical inputs", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 99999 }), async (cents) => {
        const bal = (cents / 100).toFixed(2);
        const routes = {
          [DOCS]: [docRow({ extracted_fields: { balance: bal, statement_date: "2026-02-10" } })],
          [BALANCES]: [balRow({ current_balance: bal })],
        };
        const a = await new StatementBalanceMatcher().run(
          makeDeps(fakePool(routes).pool).deps,
          makeInput(),
        );
        const b = await new StatementBalanceMatcher().run(
          makeDeps(fakePool(routes).pool).deps,
          makeInput(),
        );
        expect(a.matchesProduced.length).toBe(b.matchesProduced.length);
      }),
    );
  });
});
