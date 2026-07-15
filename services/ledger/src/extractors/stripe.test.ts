import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, isBrainError, newTenantId, newUserId } from "@brain/shared";
import { centsToDecimal, normalizeStripeArtifact } from "./stripe.js";
import { extractorForParser, registeredParsers } from "./registry.js";

/** Fake pool that captures each query and routes rows by substring. */
function capturingPool(routes: Record<string, Array<Record<string, unknown>>> = {}): {
  pool: Pool;
  calls: { text: string; values: unknown[] }[];
} {
  const calls: { text: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text.trim())) return { rows: [], rowCount: 0 };
      if (text.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
      for (const [pattern, rows] of Object.entries(routes)) {
        if (text.includes(pattern)) return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as Pool, calls };
}

const ctx = { tenantId: newTenantId(), actor: newUserId() };

function input(objectType: string, objects: unknown[], over: Record<string, unknown> = {}) {
  return {
    rawParsedId: "prs_s1",
    rawArtifactId: "raw_s1",
    payload: {
      object_type: objectType,
      stripe_account_id: "acct_S1",
      objects,
      ...over,
    },
    confidence: null,
  };
}

const ACCOUNT_ROUTE = {
  "INSERT INTO ledger_accounts": [{ id: "acct_LEDGER", account_type: "payment_processor" }],
};

describe("centsToDecimal", () => {
  it("converts integer minor units exactly (no f64)", () => {
    expect(centsToDecimal(125000)).toBe("1250.00");
    expect(centsToDecimal(-1250)).toBe("12.50"); // direction carries the sign
    expect(centsToDecimal(7)).toBe("0.07");
    expect(centsToDecimal(0)).toBe("0.00");
  });

  it("rejects non-integer amounts", () => {
    expect(() => centsToDecimal(12.5)).toThrow(/integer minor units/);
  });
});

describe("normalizeStripeArtifact — stripe_v1", () => {
  it("is registered in the parser registry", () => {
    expect(registeredParsers()).toContain("stripe_v1");
    expect(extractorForParser("stripe_v1")).toBeDefined();
  });

  it("lands charges as INFLOW transactions on the processor-balance account", async () => {
    const { pool, calls } = capturingPool({
      ...ACCOUNT_ROUTE,
      "INSERT INTO ledger_transactions": [{ id: "tx_CH" }],
    });
    const audit = new InMemoryAuditEmitter();
    const created = await normalizeStripeArtifact(
      pool,
      audit,
      ctx,
      input("charge", [
        {
          id: "ch_1",
          object: "charge",
          amount: 125000,
          currency: "usd",
          created: 1770000000,
          status: "succeeded",
          description: "Invoice INV-1004",
        },
      ]),
    );

    const acct = calls.find((c) => c.text.includes("INSERT INTO ledger_accounts"))!;
    expect(acct.values).toContain("acct_S1"); // external_account_id
    expect(acct.values).toContain("payment_processor");

    const tx = calls.find((c) => c.text.includes("INSERT INTO ledger_transactions"))!;
    expect(tx.values[3]).toBe("ch_1"); // external_transaction_id
    expect(tx.values[4]).toBe("1250.00"); // exact decimal
    expect(tx.values[5]).toBe("USD");
    expect(tx.values[6]).toBe("inflow"); // correct direction (AC)
    expect(tx.values[11]).toBe("posted"); // succeeded -> posted
    expect(tx.values).toContain("extracted"); // provenance (Phase 2 trust mapping)

    expect(created.map((r) => r.entity)).toEqual(["account", "transaction"]);
    expect(audit.events.some((e) => e.action === "ledger.transaction.posted")).toBe(true);
  });

  it("skips one charge when its write fails and continues the batch", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (text: string, values: unknown[] = []) => {
        calls.push({ text, values });
        if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text.trim())) return { rows: [], rowCount: 0 };
        if (text.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
        if (text.includes("INSERT INTO ledger_accounts")) {
          return { rows: [{ id: "acct_LEDGER", account_type: "payment_processor" }], rowCount: 1 };
        }
        if (text.includes("INSERT INTO ledger_transactions")) {
          if (values[3] === "ch_bad") throw new Error("bad charge row");
          return { rows: [{ id: `tx_${String(values[3])}` }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = { connect: async () => client } as unknown as Pool;

    const created = await normalizeStripeArtifact(
      pool,
      new InMemoryAuditEmitter(),
      ctx,
      input("charge", [
        { id: "ch_bad", amount: 100, currency: "usd", created: 1, status: "succeeded" },
        { id: "ch_good", amount: 200, currency: "usd", created: 2, status: "succeeded" },
      ]),
    );

    expect(created).toContainEqual({ entity: "transaction", id: "tx_ch_good" });
    expect(calls.filter((c) => c.text.includes("INSERT INTO ledger_transactions"))).toHaveLength(2);
  });

  it("lands payouts as OUTFLOW transactions (AC: correct direction)", async () => {
    const { pool, calls } = capturingPool({
      ...ACCOUNT_ROUTE,
      "INSERT INTO ledger_transactions": [{ id: "tx_PO" }],
    });
    await normalizeStripeArtifact(
      pool,
      new InMemoryAuditEmitter(),
      ctx,
      input("payout", [
        { id: "po_1", amount: 90000, currency: "usd", created: 1770000300, status: "paid" },
      ]),
    );
    const tx = calls.find((c) => c.text.includes("INSERT INTO ledger_transactions"))!;
    expect(tx.values[3]).toBe("po_1");
    expect(tx.values[6]).toBe("outflow");
    expect(tx.values[11]).toBe("posted"); // paid -> posted
  });

  it("lands refunds as OUTFLOW and pending charges as pending", async () => {
    const { pool, calls } = capturingPool({
      ...ACCOUNT_ROUTE,
      "INSERT INTO ledger_transactions": [{ id: "tx_RE" }],
    });
    await normalizeStripeArtifact(
      pool,
      new InMemoryAuditEmitter(),
      ctx,
      input("refund", [
        { id: "re_1", amount: 500, currency: "usd", created: 1770000600, status: "pending" },
      ]),
    );
    const tx = calls.find((c) => c.text.includes("INSERT INTO ledger_transactions"))!;
    expect(tx.values[6]).toBe("outflow");
    expect(tx.values[11]).toBe("pending");
  });

  it("promotes only FEE balance_transactions (charges/payouts come from their own pages)", async () => {
    const { pool, calls } = capturingPool({
      ...ACCOUNT_ROUTE,
      "INSERT INTO ledger_transactions": [{ id: "tx_FEE" }],
    });
    await normalizeStripeArtifact(
      pool,
      new InMemoryAuditEmitter(),
      ctx,
      input("balance_transaction", [
        { id: "txn_ch", type: "charge", amount: 125000, currency: "usd", created: 1 },
        { id: "txn_fee", type: "stripe_fee", amount: -363, currency: "usd", created: 2 },
        { id: "txn_po", type: "payout", amount: -90000, currency: "usd", created: 3 },
      ]),
    );
    const txInserts = calls.filter((c) => c.text.includes("INSERT INTO ledger_transactions"));
    expect(txInserts).toHaveLength(1); // fee only — no double count
    expect(txInserts[0]!.values[3]).toBe("txn_fee");
    expect(txInserts[0]!.values[4]).toBe("3.63");
    expect(txInserts[0]!.values[6]).toBe("outflow");
  });

  it("lands customers as counterparties with namespaced stripe metadata", async () => {
    const { pool, calls } = capturingPool({
      "INSERT INTO ledger_counterparties": [{ id: "cp_CUS" }],
    });
    const created = await normalizeStripeArtifact(
      pool,
      new InMemoryAuditEmitter(),
      ctx,
      input("customer", [{ id: "cus_1", name: "Globex Corp", email: "ap@globex.example" }]),
    );
    const cp = calls.find((c) => c.text.includes("INSERT INTO ledger_counterparties"))!;
    expect(cp.values).toContain("Globex Corp");
    expect(cp.values).toContain("customer");
    const metadata = cp.values.find(
      (v) => typeof v === "string" && (v as string).includes("cus_1"),
    );
    expect(metadata).toBeDefined(); // provider-only fields stay namespaced
    expect(created.map((r) => r.entity)).toEqual(["counterparty"]);
  });

  it("lands disputes as disputed payable obligations", async () => {
    const { pool, calls } = capturingPool({
      "INSERT INTO ledger_counterparties": [{ id: "cp_STRIPE" }],
      "INSERT INTO ledger_obligations": [{ id: "obl_DSP" }],
    });
    const created = await normalizeStripeArtifact(
      pool,
      new InMemoryAuditEmitter(),
      ctx,
      input("dispute", [
        {
          id: "dp_1",
          amount: 125000,
          currency: "usd",
          created: 1770000000,
          status: "needs_response",
          evidence_details: { due_by: 1770600000 },
        },
      ]),
    );
    const obl = calls.find((c) => c.text.includes("INSERT INTO ledger_obligations"))!;
    expect(obl.values).toContain("1250.00");
    expect(obl.values).toContain("disputed");
    expect(obl.values).toContain("payable");
    expect(obl.values).toContain("stripe:dispute:dp_1");
    expect(created.map((r) => r.entity)).toEqual(["counterparty", "obligation"]);
  });

  it("is idempotent: a re-run dedups on (account, external_transaction_id)", async () => {
    // The writer routes ON CONFLICT through a SELECT-existing path; this pins
    // that the extractor passes the stable Stripe object id as the dedup key.
    const { pool, calls } = capturingPool({
      ...ACCOUNT_ROUTE,
      "INSERT INTO ledger_transactions": [{ id: "tx_SAME" }],
    });
    const one = input("charge", [
      { id: "ch_1", amount: 100, currency: "usd", created: 1, status: "succeeded" },
    ]);
    await normalizeStripeArtifact(pool, new InMemoryAuditEmitter(), ctx, one);
    await normalizeStripeArtifact(pool, new InMemoryAuditEmitter(), ctx, one);
    const ids = calls
      .filter((c) => c.text.includes("INSERT INTO ledger_transactions"))
      .map((c) => c.values[3]);
    expect(ids).toEqual(["ch_1", "ch_1"]); // same key both times — DB unique dedups
  });

  it("rejects a payload without object coordinates", async () => {
    const { pool } = capturingPool();
    try {
      await normalizeStripeArtifact(pool, new InMemoryAuditEmitter(), ctx, {
        rawParsedId: "prs_x",
        rawArtifactId: "raw_x",
        payload: { objects: "nope" },
        confidence: null,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
      if (isBrainError(err)) expect(err.code).toBe("ledger_row_invalid");
    }
  });
});
