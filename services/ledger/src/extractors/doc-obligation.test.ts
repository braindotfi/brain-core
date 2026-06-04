import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, isBrainError, newTenantId, newUserId } from "@brain/shared";
import { normalizeDocObligationArtifact, parseDocObligationPayload } from "./doc-obligation.js";

/** Fake pool that captures each query and routes routed rows by substring. */
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

const validPayload = {
  counterparty_name: "Acme Utilities",
  direction: "payable",
  type: "bill",
  amount: "120.50",
  currency: "USD",
  due_date: "2026-07-01T00:00:00Z",
};

describe("parseDocObligationPayload", () => {
  it("accepts a well-formed payload and defaults status to upcoming", () => {
    const parsed = parseDocObligationPayload(validPayload);
    expect(parsed.counterparty_name).toBe("Acme Utilities");
    expect(parsed.direction).toBe("payable");
    expect(parsed.type).toBe("bill");
    expect(parsed.amount).toBe("120.50");
    expect(parsed.status).toBe("upcoming");
  });

  it("carries optional minimum_due and recurrence through", () => {
    const parsed = parseDocObligationPayload({
      ...validPayload,
      minimum_due: "25.00",
      recurrence: "FREQ=MONTHLY",
      status: "due",
    });
    expect(parsed.minimum_due).toBe("25.00");
    expect(parsed.recurrence).toBe("FREQ=MONTHLY");
    expect(parsed.status).toBe("due");
  });

  it.each([
    ["missing counterparty_name", { ...validPayload, counterparty_name: undefined }],
    ["bad direction", { ...validPayload, direction: "sideways" }],
    ["bad type", { ...validPayload, type: "mortgage" }],
    ["non-decimal amount", { ...validPayload, amount: "ten dollars" }],
    ["bad currency", { ...validPayload, currency: "usd" }],
    ["bad due_date", { ...validPayload, due_date: "not-a-date" }],
    ["bad status", { ...validPayload, status: "archived" }],
    ["non-decimal minimum_due", { ...validPayload, minimum_due: "lots" }],
  ])("rejects %s with ledger_row_invalid", (_label, input) => {
    try {
      parseDocObligationPayload(input as Record<string, unknown>);
      throw new Error("expected parseDocObligationPayload to throw");
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
      if (isBrainError(err)) expect(err.code).toBe("ledger_row_invalid");
    }
  });
});

describe("normalizeDocObligationArtifact", () => {
  it("creates a vendor counterparty + obligation that references it, both agent_contributed", async () => {
    const { pool, calls } = capturingPool({
      "INSERT INTO ledger_counterparties": [{ id: "cp_vendor", type: "vendor" }],
      "INSERT INTO ledger_obligations": [{ id: "obl_1", confidence: 0.5 }],
    });
    const audit = new InMemoryAuditEmitter();

    const created = await normalizeDocObligationArtifact(pool, audit, ctx, {
      rawParsedId: "prs_1",
      rawArtifactId: "raw_1",
      payload: validPayload,
      confidence: 0.8,
    });

    expect(created).toEqual([
      { entity: "counterparty", id: "cp_vendor" },
      { entity: "obligation", id: "obl_1" },
    ]);

    const oblInsert = calls.find((c) => c.text.includes("INSERT INTO ledger_obligations"))!;
    // INSERT columns: id, owner_id, type, counterparty_id, amount_due, minimum_due,
    // currency, due_date, recurrence, status, source_ids, evidence_ids, provenance, confidence
    expect(oblInsert.values[3]).toBe("cp_vendor"); // counterparty_id references the new party
    expect(oblInsert.values[11]).toEqual(["prs_1"]); // evidence_ids = [raw_parsed_id]
    expect(oblInsert.values[12]).toBe("agent_contributed");

    const cpInsert = calls.find((c) => c.text.includes("INSERT INTO ledger_counterparties"))!;
    expect(cpInsert.values[4]).toBe("vendor"); // type column ($5)

    const actions = audit.events.map((e) => e.action);
    expect(actions).toContain("ledger.counterparty.created");
    expect(actions).toContain("ledger.obligation.created");
  });

  it("resolves a customer counterparty for a receivable", async () => {
    const { pool, calls } = capturingPool({
      "INSERT INTO ledger_counterparties": [{ id: "cp_cust", type: "customer" }],
      "INSERT INTO ledger_obligations": [{ id: "obl_2", confidence: 0.5 }],
    });
    const audit = new InMemoryAuditEmitter();

    await normalizeDocObligationArtifact(pool, audit, ctx, {
      rawParsedId: "prs_2",
      rawArtifactId: "raw_2",
      payload: { ...validPayload, direction: "receivable", type: "invoice" },
      confidence: 0.9,
    });

    const cpInsert = calls.find((c) => c.text.includes("INSERT INTO ledger_counterparties"))!;
    expect(cpInsert.values[4]).toBe("customer");
  });
});
