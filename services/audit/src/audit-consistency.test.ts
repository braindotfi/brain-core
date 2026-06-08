import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { checkAuditConsistency, verifyContentHashCursor } from "./audit-consistency.js";

/** Pool that returns a count per structural query (fork / gap / genesis). */
function fakePool(counts: { forks: number; gaps: number; invalidGenesis?: number }): {
  pool: Pool;
  sql: string[];
} {
  const sql: string[] = [];
  const pool = {
    query: vi.fn(async (text: string) => {
      sql.push(text);
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

describe("checkAuditConsistency (structural)", () => {
  it("reports zero on a clean chain and runs the fork + gap + genesis queries", async () => {
    const { pool, sql } = fakePool({ forks: 0, gaps: 0 });
    const res = await checkAuditConsistency({ privilegedPool: pool });
    expect(res).toEqual({ forks: 0, gaps: 0, invalidGenesis: 0 });
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

    expect(res).toEqual({ forks: 2, gaps: 1, invalidGenesis: 0 });
    expect(metrics.gauge).toHaveBeenCalledWith("brain.audit.consistency.fork.count", 2);
    expect(metrics.gauge).toHaveBeenCalledWith("brain.audit.consistency.gap.count", 1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("flags a tenant with multiple genesis events even when forks and gaps are zero", async () => {
    const { pool } = fakePool({ forks: 0, gaps: 0, invalidGenesis: 2 });
    const metrics = { gauge: vi.fn(), increment: vi.fn(), histogram: vi.fn(), duration: vi.fn() };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await checkAuditConsistency({ privilegedPool: pool, metrics: metrics as never });

    expect(res).toEqual({ forks: 0, gaps: 0, invalidGenesis: 2 });
    expect(metrics.gauge).toHaveBeenCalledWith("brain.audit.consistency.invalid_genesis.count", 2);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("does not log when the chain is structurally clean", async () => {
    const { pool } = fakePool({ forks: 0, gaps: 0 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await checkAuditConsistency({ privilegedPool: pool });
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

/** Pool with a connect()-able client for the cursor transaction + a direct query. */
function fakeCursorPool(opts: {
  pageRows: unknown[];
  unsupported?: number;
  openFindings?: number;
}): {
  pool: Pool;
  sql: string[];
} {
  const sql: string[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      sql.push(text);
      if (text.includes("FOR UPDATE")) {
        return {
          rows: [{ hash_schema_version: 1, last_created_at: null, last_event_id: null }],
          rowCount: 1,
        };
      }
      if (text.startsWith("SELECT id, tenant_id")) {
        return { rows: opts.pageRows, rowCount: opts.pageRows.length };
      }
      return { rows: [], rowCount: 0 }; // BEGIN / INSERT / UPDATE / COMMIT
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: async () => client,
    query: vi.fn(async (text: string) => {
      sql.push(text);
      if (text.includes("hash_schema_version >")) {
        return { rows: [{ n: String(opts.unsupported ?? 0) }], rowCount: 1 };
      }
      if (text.includes("audit_integrity_findings")) {
        return { rows: [{ n: String(opts.openFindings ?? 0) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as Pool;
  return { pool, sql };
}

describe("verifyContentHashCursor (content, paged)", () => {
  function row(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "e1",
      tenant_id: "t1",
      layer: "audit",
      actor: "system",
      action: "x",
      inputs: {},
      outputs: {},
      policy_version: null,
      policy_decision_id: null,
      before_state: null,
      after_state: null,
      prev_event_hash: null,
      created_at: new Date("2026-06-08T00:00:00.000Z"),
      event_hash: Buffer.from("00".repeat(32), "hex"), // not the real hash → mismatch
      ...over,
    };
  }

  it("flags a row whose stored hash does not recompute, records a durable finding, wraps", async () => {
    const { pool, sql } = fakeCursorPool({ pageRows: [row()], openFindings: 1 });
    const metrics = { gauge: vi.fn(), increment: vi.fn(), histogram: vi.fn(), duration: vi.fn() };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await verifyContentHashCursor({ privilegedPool: pool, metrics: metrics as never });

    expect(res.rowsVerified).toBe(1);
    expect(res.hashMismatches).toBe(1);
    expect(res.openFindings).toBe(1); // sticky, survives a later clean page
    expect(res.completedPass).toBe(true); // page < pageSize → wrapped
    expect(metrics.gauge).toHaveBeenCalledWith("brain.audit.consistency.hash_mismatch.count", 1);
    expect(metrics.gauge).toHaveBeenCalledWith("brain.audit.consistency.rows_verified.count", 1);
    expect(metrics.gauge).toHaveBeenCalledWith("brain.audit.consistency.open_findings.count", 1);
    // A durable finding is inserted (at most one open per verifier+event).
    expect(sql.some((s) => s.includes("INSERT INTO audit_integrity_findings"))).toBe(true);
    // The cursor paged in stable (created_at, id) order and recorded a full pass.
    expect(sql.some((s) => s.includes("ORDER BY created_at, id"))).toBe(true);
    expect(sql.some((s) => s.includes("completed_passes = completed_passes + 1"))).toBe(true);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("surfaces rows written by a newer (unsupported) schema version", async () => {
    const { pool } = fakeCursorPool({ pageRows: [], unsupported: 3 });
    const metrics = { gauge: vi.fn(), increment: vi.fn(), histogram: vi.fn(), duration: vi.fn() };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await verifyContentHashCursor({ privilegedPool: pool, metrics: metrics as never });

    expect(res.unsupportedVersion).toBe(3);
    expect(metrics.gauge).toHaveBeenCalledWith(
      "brain.audit.consistency.unsupported_version.count",
      3,
    );
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
