import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, isBrainError, newTenantId, newUserId } from "@brain/shared";
import { normalizeMergeAccountingArtifact } from "./merge_accounting.js";
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

// Phase 5 cutover (RFC 0005, PR-G): merge_accounting_v1 no longer writes the
// Ledger directly. Merge invoices/contacts/accounts flow through the canonical
// projection (Raw -> canonical -> Ledger projection). The extractor stays
// registered as a validated no-op so normalize still consumes the raw_parsed
// rows; the canonical projector consumes them independently.
describe("normalizeMergeAccountingArtifact — merge_accounting_v1 (post-canonical-cutover)", () => {
  it("is still registered in the parser registry", () => {
    expect(registeredParsers()).toContain("merge_accounting_v1");
    expect(extractorForParser("merge_accounting_v1")).toBeDefined();
  });

  it("writes NO Ledger rows for invoices (now a canonical projection)", async () => {
    const { pool, calls } = capturingPool();
    const created = await normalizeMergeAccountingArtifact(
      pool,
      new InMemoryAuditEmitter(),
      ctx,
      input("invoice", [
        {
          id: "inv_77",
          remote_id: "netsuite-4411",
          type: "ACCOUNTS_PAYABLE",
          contact: "Acme Industrial Supply",
          balance: 1250,
          currency: "usd",
          status: "OPEN",
          line_items: [{ account: "gl-6100-equipment" }],
        },
      ]),
    );
    expect(created).toEqual([]);
    expect(calls.some((c) => c.text.startsWith("INSERT"))).toBe(false);
  });

  it("writes NO Ledger rows for contacts (now a canonical projection)", async () => {
    const { pool, calls } = capturingPool();
    const created = await normalizeMergeAccountingArtifact(
      pool,
      new InMemoryAuditEmitter(),
      ctx,
      input("contact", [
        { id: "con_1", name: "Acme Industrial Supply", is_supplier: true },
        { id: "con_2", name: "Globex Corp", is_customer: true },
      ]),
    );
    expect(created).toEqual([]);
    expect(calls.some((c) => c.text.startsWith("INSERT"))).toBe(false);
  });

  it("writes nothing for accounting object types either", async () => {
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

  it("rejects malformed payloads (missing object_type / objects)", async () => {
    const { pool } = capturingPool();
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
