import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { checkAuditConsistency } from "./audit-consistency.js";

/** Pool that returns a count for the fork query and the gap query independently. */
function fakePool(counts: { forks: number; gaps: number }): { pool: Pool; sql: string[] } {
  const sql: string[] = [];
  const pool = {
    query: vi.fn(async (text: string) => {
      sql.push(text);
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
    expect(res).toEqual({ forks: 0, gaps: 0 });
    // Fork query groups by predecessor; gap query is an anti-join on event_hash.
    expect(sql.some((s) => s.includes("GROUP BY tenant_id, prev_event_hash"))).toBe(true);
    expect(sql.some((s) => s.includes("HAVING count(*) > 1"))).toBe(true);
    expect(sql.some((s) => s.includes("NOT EXISTS"))).toBe(true);
  });

  it("surfaces fork + gap counts and emits gauges + a critical log", async () => {
    const { pool } = fakePool({ forks: 2, gaps: 1 });
    const metrics = { gauge: vi.fn(), increment: vi.fn(), histogram: vi.fn(), duration: vi.fn() };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await checkAuditConsistency({ privilegedPool: pool, metrics: metrics as never });

    expect(res).toEqual({ forks: 2, gaps: 1 });
    expect(metrics.gauge).toHaveBeenCalledWith("brain.audit.consistency.fork.count", 2);
    expect(metrics.gauge).toHaveBeenCalledWith("brain.audit.consistency.gap.count", 1);
    // A non-zero count is a P0-grade signal → critical log.
    expect(errSpy).toHaveBeenCalled();
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
