import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, isBrainError, newTenantId, newUserId } from "@brain/shared";
import { mergeAmountToDecimal, normalizeMergeAccountingArtifact } from "./merge_accounting.js";
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

function input(objectType: string, objects: unknown[]) {
  return {
    rawParsedId: "prs_m1",
    rawArtifactId: "raw_m1",
    payload: { object_type: objectType, merge_integration: "NetSuite", objects },
    confidence: null,
  };
}

describe("mergeAmountToDecimal", () => {
  it("normalizes numbers and strings to two-plus decimal places", () => {
    expect(mergeAmountToDecimal(1250)).toBe("1250.00");
    expect(mergeAmountToDecimal("1250.5")).toBe("1250.50");
    expect(mergeAmountToDecimal("1250.505")).toBe("1250.505");
    expect(mergeAmountToDecimal(null)).toBeNull();
    expect(mergeAmountToDecimal("not money")).toBeNull();
  });
});

describe("normalizeMergeAccountingArtifact — merge_accounting_v1", () => {
  it("is registered in the parser registry", () => {
    expect(registeredParsers()).toContain("merge_accounting_v1");
    expect(extractorForParser("merge_accounting_v1")).toBeDefined();
  });

  it("lands an open AP bill as a payable obligation with GL coding in extensions (the wedge AC)", async () => {
    const { pool, calls } = capturingPool({
      "INSERT INTO ledger_counterparties": [{ id: "cp_VENDOR" }],
      "INSERT INTO ledger_obligations": [{ id: "obl_BILL", confidence: 0.85 }],
    });
    const audit = new InMemoryAuditEmitter();
    const created = await normalizeMergeAccountingArtifact(
      pool,
      audit,
      ctx,
      input("invoice", [
        {
          id: "inv_77",
          remote_id: "netsuite-4411",
          type: "ACCOUNTS_PAYABLE",
          contact: "Acme Industrial Supply",
          number: "BILL-2031",
          due_date: "2026-07-01T00:00:00Z",
          total_amount: 1250,
          balance: 1250,
          currency: "usd",
          status: "OPEN",
          line_items: [
            { account: "gl-6100-equipment", description: "Hydraulic press parts" },
            { account: "gl-6200-freight", description: "Freight" },
          ],
        },
      ]),
    );

    const obl = calls.find((c) => c.text.includes("INSERT INTO ledger_obligations"))!;
    expect(obl.values).toContain("bill");
    expect(obl.values).toContain("1250.00");
    expect(obl.values).toContain("payable");
    expect(obl.values).toContain("due");
    expect(obl.values).toContain("extracted");
    // GL coding + original-source id preserved in namespaced extensions.
    const metadata = obl.values.find(
      (v) => typeof v === "string" && (v as string).includes("gl-6100-equipment"),
    ) as string;
    expect(metadata).toBeDefined();
    const parsed = JSON.parse(metadata) as { merge: Record<string, unknown> };
    expect(parsed.merge.remote_id).toBe("netsuite-4411"); // NetSuite visible, not just Merge
    expect(parsed.merge.integration).toBe("NetSuite");
    expect(parsed.merge.gl_accounts).toEqual(["gl-6100-equipment", "gl-6200-freight"]);

    const cp = calls.find((c) => c.text.includes("INSERT INTO ledger_counterparties"))!;
    expect(cp.values).toContain("Acme Industrial Supply");
    expect(cp.values).toContain("vendor");

    expect(created.map((r) => r.entity)).toEqual(["counterparty", "obligation"]);
  });

  it("lands an AR invoice as a receivable obligation against a customer", async () => {
    const { pool, calls } = capturingPool({
      "INSERT INTO ledger_counterparties": [{ id: "cp_CUST" }],
      "INSERT INTO ledger_obligations": [{ id: "obl_AR" }],
    });
    await normalizeMergeAccountingArtifact(
      pool,
      new InMemoryAuditEmitter(),
      ctx,
      input("invoice", [
        {
          id: "inv_88",
          type: "ACCOUNTS_RECEIVABLE",
          contact: "Globex Corp",
          due_date: "2026-06-20T00:00:00Z",
          balance: "900.00",
          currency: "USD",
          status: "OPEN",
        },
      ]),
    );
    const obl = calls.find((c) => c.text.includes("INSERT INTO ledger_obligations"))!;
    expect(obl.values).toContain("invoice");
    expect(obl.values).toContain("receivable");
    const cp = calls.find((c) => c.text.includes("INSERT INTO ledger_counterparties"))!;
    expect(cp.values).toContain("customer");
  });

  it("maps contacts to vendor/customer counterparties with merge metadata", async () => {
    const { pool, calls } = capturingPool({
      "INSERT INTO ledger_counterparties": [{ id: "cp_1" }],
    });
    const created = await normalizeMergeAccountingArtifact(
      pool,
      new InMemoryAuditEmitter(),
      ctx,
      input("contact", [
        { id: "con_1", remote_id: "ns-301", name: "Acme Industrial Supply", is_supplier: true },
        { id: "con_2", remote_id: "ns-302", name: "Globex Corp", is_customer: true },
      ]),
    );
    const inserts = calls.filter((c) => c.text.includes("INSERT INTO ledger_counterparties"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.values).toContain("vendor");
    expect(inserts[1]!.values).toContain("customer");
    expect(created).toHaveLength(2);
  });

  it("retains unmapped object types in raw without writing Ledger rows", async () => {
    const { pool, calls } = capturingPool();
    const created = await normalizeMergeAccountingArtifact(
      pool,
      new InMemoryAuditEmitter(),
      ctx,
      input("journal_entry", [{ id: "je_1", lines: [] }]),
    );
    expect(created).toEqual([]);
    expect(calls.some((c) => c.text.startsWith("INSERT"))).toBe(false);
  });

  it("skips invoices that are neither AP nor AR and rejects malformed payloads", async () => {
    const { pool } = capturingPool();
    const created = await normalizeMergeAccountingArtifact(
      pool,
      new InMemoryAuditEmitter(),
      ctx,
      input("invoice", [{ id: "inv_x", type: "CREDIT_NOTE", balance: 10 }]),
    );
    expect(created).toEqual([]);

    try {
      await normalizeMergeAccountingArtifact(pool, new InMemoryAuditEmitter(), ctx, {
        rawParsedId: "prs_x",
        rawArtifactId: "raw_x",
        payload: { objects: "nope" },
        confidence: null,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
    }
  });
});
