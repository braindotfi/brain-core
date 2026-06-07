import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { checkAuditConsistency } from "./audit-consistency.js";

/** Pool that returns a count per structural query, plus optional content rows. */
function fakePool(counts: {
  forks: number;
  gaps: number;
  invalidGenesis?: number;
  contentRows?: unknown[];
}): {
  pool: Pool;
  sql: string[];
} {
  const sql: string[] = [];
  const pool = {
    query: vi.fn(async (text: string) => {
      sql.push(text);
      // Content-hash recompute query (current schema version, bounded scan).
      if (text.includes("hash_schema_version")) {
        const rows = counts.contentRows ?? [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("invalid_genesis")) {
        return { rows: [{ n: String(counts.invalidGenesis ?? 0) }], rowCount: 1 };
      }
      if (text.includes("GROUP BY tenant_id, prev_event_hash")) {
        return { rows: [{ n: String(counts.forks) }], rowCount: 1 };
      }
      if (text.includes("NOT EXISTS")) {
        return { rows: [{ n: String(counts.gaps) }], rowCount: 1 };
      }
      return { rows: [{ n: "0" }], rowCount: 1 };
    }),
  } as unknown as Pool;
  return { pool, sql };
}

describe("checkAuditConsistency", () => {
  it("reports zero on a clean chain and runs the fork + gap queries", async () => {
    const { pool, sql } = fakePool({ forks: 0, gaps: 0 });
    const res = await checkAuditConsistency({ privilegedPool: pool });
    expect(res).toEqual({ forks: 0, gaps: 0, invalidGenesis: 0, hashMismatches: 0 });
    // Fork query groups by predecessor; gap query is an anti-join on event_hash;
    // genesis query counts tenants without exactly one null-predecessor event.
    expect(sql.some((s) => s.includes("GROUP BY tenant_id, prev_event_hash"))).toBe(true);
    expect(sql.some((s) => s.includes("HAVING count(*) > 1"))).toBe(true);
    expect(sql.some((s) => s.includes("NOT EXISTS"))).toBe(true);
    expect(sql.some((s) => s.includes("FILTER (WHERE prev_event_hash IS NULL) <> 1"))).toBe(true);
  });

  it("surfaces fork + gap counts and emits gauges + a critical log", async () => {
    const { pool } = fakePool({ forks: 2, gaps: 1 });
    const metrics = { gauge: vi.fn(), increment: vi.fn(), histogram: vi.fn(), duration: vi.fn() };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await checkAuditConsistency({ privilegedPool: pool, metrics: metrics as never });

    expect(res).toEqual({ forks: 2, gaps: 1, invalidGenesis: 0, hashMismatches: 0 });
    expect(metrics.gauge).toHaveBeenCalledWith("brain.audit.consistency.fork.count", 2);
    expect(metrics.gauge).toHaveBeenCalledWith("brain.audit.consistency.gap.count", 1);
    // A non-zero count is a P0-grade signal → critical log.
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("flags a tenant with multiple genesis events even when forks and gaps are zero", async () => {
    const { pool } = fakePool({ forks: 0, gaps: 0, invalidGenesis: 2 });
    const metrics = { gauge: vi.fn(), increment: vi.fn(), histogram: vi.fn(), duration: vi.fn() };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await checkAuditConsistency({ privilegedPool: pool, metrics: metrics as never });

    // Two genesis events escape fork + gap detection; this is the only signal.
    expect(res).toEqual({ forks: 0, gaps: 0, invalidGenesis: 2, hashMismatches: 0 });
    expect(metrics.gauge).toHaveBeenCalledWith("brain.audit.consistency.invalid_genesis.count", 2);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("flags a content-hash mismatch when a stored event_hash does not recompute", async () => {
    // A row whose stored event_hash does not match the recompute of its logical
    // fields — a content mutation the structural checks cannot see.
    const row = {
      id: "evt_1",
      tenant_id: "tnt_1",
      layer: "audit",
      actor: "system",
      action: "test.tamper",
      inputs: {},
      outputs: {},
      policy_version: null,
      policy_decision_id: null,
      before_state: null,
      after_state: null,
      prev_event_hash: null,
      created_at: new Date("2026-06-08T00:00:00.000Z"),
      event_hash: Buffer.from("00".repeat(32), "hex"), // not the real hash of the fields
    };
    const { pool, sql } = fakePool({ forks: 0, gaps: 0, contentRows: [row] });
    const metrics = { gauge: vi.fn(), increment: vi.fn(), histogram: vi.fn(), duration: vi.fn() };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await checkAuditConsistency({ privilegedPool: pool, metrics: metrics as never });

    expect(res.hashMismatches).toBe(1);
    expect(metrics.gauge).toHaveBeenCalledWith("brain.audit.consistency.hash_mismatch.count", 1);
    expect(errSpy).toHaveBeenCalled();
    // The recompute scans current-version rows only.
    expect(sql.some((s) => s.includes("hash_schema_version = $1"))).toBe(true);
    errSpy.mockRestore();
  });

  it("does not log when the chain is clean", async () => {
    const { pool } = fakePool({ forks: 0, gaps: 0 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await checkAuditConsistency({ privilegedPool: pool });
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
