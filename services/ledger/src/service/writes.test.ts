import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, newTenantId, newUserId } from "@brain/shared";
import { upsertCounterpartyRow } from "./writes.js";

/** Fake pool that captures each query's text + values; routes by substring. */
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
const AGENT_ID = "agent_01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("upsertCounterpartyRow — agent counterparties (RFC 0001)", () => {
  it("creates a type='agent' counterparty and persists agent_id", async () => {
    const { pool, calls } = capturingPool({
      "INSERT INTO ledger_counterparties": [
        { id: "cp_agent", type: "agent", agent_id: AGENT_ID, name: "Payments Agent" },
      ],
    });
    const audit = new InMemoryAuditEmitter();
    const { row, created } = await upsertCounterpartyRow(pool, audit, ctx, {
      name: "Payments Agent",
      type: "agent",
      agent_id: AGENT_ID,
      source_ids: ["raw_1"],
      evidence_ids: [],
      provenance: "extracted",
      confidence: 0.9,
    });

    expect(created).toBe(true);
    expect(row.type).toBe("agent");
    expect(row.agent_id).toBe(AGENT_ID);

    const insert = calls.find((c) => c.text.includes("INSERT INTO ledger_counterparties"))!;
    // agent_id is the 13th positional param ($13).
    expect(insert.values[12]).toBe(AGENT_ID);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]!.action).toBe("ledger.counterparty.created");
  });

  it("defaults agent_id to null for a non-agent counterparty", async () => {
    const { pool, calls } = capturingPool({
      "INSERT INTO ledger_counterparties": [{ id: "cp_v", type: "vendor", agent_id: null }],
    });
    const audit = new InMemoryAuditEmitter();
    await upsertCounterpartyRow(pool, audit, ctx, {
      name: "Acme",
      type: "vendor",
      source_ids: ["raw_1"],
      evidence_ids: [],
      provenance: "extracted",
      confidence: 0.9,
    });
    const insert = calls.find((c) => c.text.includes("INSERT INTO ledger_counterparties"))!;
    expect(insert.values[12]).toBeNull();
  });
});
