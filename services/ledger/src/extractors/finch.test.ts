import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, isBrainError, newTenantId, newUserId } from "@brain/shared";
import { normalizeFinchArtifact } from "./finch.js";
import { extractorForParser, registeredParsers } from "./registry.js";

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
    rawParsedId: "prs_f1",
    rawArtifactId: "raw_f1",
    payload: { object_type: objectType, objects },
    confidence: null,
  };
}

const ACCOUNT_ROUTE = {
  "INSERT INTO ledger_accounts": [{ id: "acct_PAYROLL" }],
};

describe("normalizeFinchArtifact — finch_payroll_v1", () => {
  it("is registered under the spec parser id", () => {
    expect(registeredParsers()).toContain("finch_payroll_v1");
    expect(extractorForParser("finch_payroll_v1")).toBeDefined();
  });

  it("lands directory rows as PII-tagged employee counterparties (names only)", async () => {
    const { pool, calls } = capturingPool({
      "INSERT INTO ledger_counterparties": [{ id: "cp_EMP" }],
    });
    const created = await normalizeFinchArtifact(
      pool,
      new InMemoryAuditEmitter(),
      ctx,
      input("individual", [
        {
          id: "ind_1",
          first_name: "Dana",
          last_name: "Reyes",
          department: { name: "Engineering" },
          is_active: true,
        },
      ]),
    );
    const cp = calls.find((c) => c.text.includes("INSERT INTO ledger_counterparties"))!;
    expect(cp.values).toContain("Dana Reyes");
    expect(cp.values).toContain("employee");
    const metadata = cp.values.find(
      (v) => typeof v === "string" && (v as string).includes("pii"),
    ) as string;
    expect(JSON.parse(metadata)).toMatchObject({
      pii: true,
      finch: { individual_id: "ind_1", department: "Engineering" },
    });
    // PII minimization: nothing beyond name/department/linkage in the row.
    expect(metadata).not.toMatch(/ssn|dob|salary|rate|compensation/i);
    expect(created.map((r) => r.entity)).toEqual(["counterparty"]);
  });

  it("lands a completed pay run as a net-pay OUTFLOW transaction (AC)", async () => {
    const { pool, calls } = capturingPool({
      ...ACCOUNT_ROUTE,
      "INSERT INTO ledger_transactions": [{ id: "tx_RUN" }],
    });
    const created = await normalizeFinchArtifact(
      pool,
      new InMemoryAuditEmitter(),
      ctx,
      input("pay_run", [
        {
          id: "pay_1",
          pay_date: "2026-06-05",
          company_debit: { amount: 1843500 },
          gross_pay: { amount: 2400000 },
          net_pay: { amount: 1700000 },
          individual_ids: ["ind_1", "ind_2"],
        },
      ]),
    );
    const acct = calls.find((c) => c.text.includes("INSERT INTO ledger_accounts"))!;
    expect(acct.values).toContain("finch:payroll");
    expect(acct.values).toContain("payment_processor");

    const tx = calls.find((c) => c.text.includes("INSERT INTO ledger_transactions"))!;
    expect(tx.values[3]).toBe("pay_1"); // idempotency by payment id
    expect(tx.values[4]).toBe("18435.00");
    expect(tx.values[6]).toBe("outflow");
    expect(created.map((r) => r.entity)).toEqual(["account", "transaction"]);
  });

  it("lands an upcoming pay run as a payroll obligation due at the pay date (AC)", async () => {
    const { pool, calls } = capturingPool({
      ...ACCOUNT_ROUTE,
      "INSERT INTO ledger_counterparties": [{ id: "cp_PROC" }],
      "INSERT INTO ledger_obligations": [{ id: "obl_RUN" }],
    });
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const created = await normalizeFinchArtifact(
      pool,
      new InMemoryAuditEmitter(),
      ctx,
      input("pay_run", [{ id: "pay_2", pay_date: future, company_debit: { amount: 500000 } }]),
    );
    const obl = calls.find((c) => c.text.includes("INSERT INTO ledger_obligations"))!;
    expect(obl.values).toContain("payroll");
    expect(obl.values).toContain("5000.00");
    expect(obl.values).toContain("payable");
    expect(obl.values).toContain("upcoming");
    // Aggregates only in extensions — no per-individual compensation.
    const metadata = obl.values.find(
      (v) => typeof v === "string" && (v as string).includes("payment_id"),
    ) as string;
    expect(JSON.parse(metadata).finch).toMatchObject({ payment_id: "pay_2" });
    expect(created.map((r) => r.entity)).toEqual(["account", "counterparty", "obligation"]);
  });

  it("skips malformed runs and rejects malformed payloads", async () => {
    const { pool, calls } = capturingPool(ACCOUNT_ROUTE);
    const created = await normalizeFinchArtifact(
      pool,
      new InMemoryAuditEmitter(),
      ctx,
      input("pay_run", [{ id: "pay_x", pay_date: "not-a-date", company_debit: { amount: 100 } }]),
    );
    expect(created.map((r) => r.entity)).toEqual(["account"]);
    expect(calls.some((c) => c.text.includes("INSERT INTO ledger_transactions"))).toBe(false);

    try {
      await normalizeFinchArtifact(pool, new InMemoryAuditEmitter(), ctx, {
        rawParsedId: "prs_x",
        rawArtifactId: "raw_x",
        payload: {},
        confidence: null,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
    }
  });
});
