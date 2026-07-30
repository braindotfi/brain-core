import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  ANCHOR_ROOT_VERIFIER_NAME,
  checkAuditConsistency,
  reportVerifierHealth,
  startAuditConsistencyVerifier,
  verifyAnchorRoots,
  verifyContentHashCursor,
} from "./audit-consistency.js";
import { buildTree } from "./merkle.js";

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
  legacy?: number;
  openFindings?: number;
  lastPassStatus?: "never" | "clean" | "failed";
  currentPassFailures?: number;
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
          rows: [
            {
              hash_schema_version: 1,
              last_created_at: null,
              last_event_id: null,
              current_pass_failure_count: 0,
            },
          ],
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
      if (text.includes("hash_schema_version <")) {
        return { rows: [{ n: String(opts.legacy ?? 0) }], rowCount: 1 };
      }
      if (text.includes("audit_integrity_findings")) {
        return { rows: [{ n: String(opts.openFindings ?? 0) }], rowCount: 1 };
      }
      if (text.includes("last_pass_status")) {
        return {
          rows: [
            {
              last_pass_status: opts.lastPassStatus ?? "clean",
              current_pass_failure_count: String(opts.currentPassFailures ?? 0),
              seconds_since_clean: opts.lastPassStatus === "never" ? null : 0,
            },
          ],
          rowCount: 1,
        };
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

  it("discloses legacy (older-version) rows as a coverage gap without logging a P0 break", async () => {
    // No mismatches, no unsupported, no open findings — only legacy v0 rows present.
    const { pool } = fakeCursorPool({ pageRows: [], legacy: 5 });
    const metrics = { gauge: vi.fn(), increment: vi.fn(), histogram: vi.fn(), duration: vi.fn() };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await verifyContentHashCursor({ privilegedPool: pool, metrics: metrics as never });

    expect(res.legacyUnverifiable).toBe(5);
    expect(metrics.gauge).toHaveBeenCalledWith(
      "brain.audit.consistency.legacy_unverifiable.count",
      5,
    );
    // A known coverage gap is disclosed via the gauge, NOT escalated to the
    // per-cycle integrity error log (which would spam on a permanent population).
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("reports a CLEAN completed pass via last_pass_clean=1", async () => {
    const { pool } = fakeCursorPool({
      pageRows: [],
      lastPassStatus: "clean",
      currentPassFailures: 0,
    });
    const metrics = { gauge: vi.fn(), increment: vi.fn(), histogram: vi.fn(), duration: vi.fn() };

    const res = await verifyContentHashCursor({ privilegedPool: pool, metrics: metrics as never });

    expect(res.lastPassClean).toBe(true);
    expect(res.currentPassFailureCount).toBe(0);
    expect(metrics.gauge).toHaveBeenCalledWith("brain.audit.consistency.last_pass_clean", 1);
    expect(metrics.gauge).toHaveBeenCalledWith(
      "brain.audit.consistency.current_pass_failure_count",
      0,
    );
    expect(metrics.gauge).toHaveBeenCalledWith(
      "brain.audit.consistency.seconds_since_clean_full_pass",
      0,
    );
  });

  it("reports a FAILED completed pass via last_pass_clean=0 (a finished pass is not a clean one)", async () => {
    const { pool } = fakeCursorPool({ pageRows: [], lastPassStatus: "failed" });
    const metrics = { gauge: vi.fn(), increment: vi.fn(), histogram: vi.fn(), duration: vi.fn() };

    const res = await verifyContentHashCursor({ privilegedPool: pool, metrics: metrics as never });

    expect(res.lastPassClean).toBe(false);
    expect(metrics.gauge).toHaveBeenCalledWith("brain.audit.consistency.last_pass_clean", 0);
  });
});

interface FakeAnchorRow {
  id: string;
  tenant_id: string;
  merkle_root: Buffer;
  event_count: number;
  period_start: Date;
  period_end: Date;
}

/**
 * Cursor-aware fake for verifyAnchorRoots: a connect()-able client for the
 * checkpoint transaction (keyset SELECT + per-anchor window reads + the
 * checkpoint UPDATE), plus a direct pool.query for the post-commit
 * pass-cleanliness gauge read. The checkpoint state is mutable in-closure so
 * consecutive calls to verifyAnchorRoots against the SAME fake behave like
 * consecutive cycles against a real durable cursor.
 */
function fakeAnchorRootCursorPool(opts: {
  /** All confirmed on-chain anchors, in period_end ASC order. */
  anchors: FakeAnchorRow[];
  /** anchor id -> the event_hash rows CURRENTLY in that anchor's window. */
  eventsByAnchor: Record<string, Buffer[]>;
  pageSize: number;
}): { pool: Pool; sql: string[]; seenTenantIds: string[] } {
  const sql: string[] = [];
  const seenTenantIds: string[] = [];
  let cursorPeriodEnd: Date | null = null;
  let cursorAnchorId: string | null = null;
  let passFailureAccum = 0;
  let passStatus: "never" | "clean" | "failed" = "never";
  let hasHadCleanPass = false;

  const client = {
    query: vi.fn(async (text: string, params: unknown[] = []) => {
      sql.push(text);
      if (text.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              last_created_at: cursorPeriodEnd,
              last_event_id: cursorAnchorId,
              current_pass_failure_count: passFailureAccum,
            },
          ],
          rowCount: 1,
        };
      }
      if (text.startsWith("SELECT id, tenant_id, merkle_root")) {
        const remaining = opts.anchors.filter((a) => {
          if (cursorAnchorId === null || cursorPeriodEnd === null) return true;
          if (a.period_end.getTime() !== cursorPeriodEnd.getTime()) {
            return a.period_end.getTime() > cursorPeriodEnd!.getTime();
          }
          return a.id > cursorAnchorId!;
        });
        const page = remaining.slice(0, opts.pageSize);
        return { rows: page, rowCount: page.length };
      }
      if (text.includes("FROM audit_events") && text.includes("tenant_id = $1")) {
        const tenantId = params[0] as string;
        seenTenantIds.push(tenantId);
        const anchor = opts.anchors.find((a) => a.tenant_id === tenantId);
        const hashes = anchor === undefined ? [] : (opts.eventsByAnchor[anchor.id] ?? []);
        return { rows: hashes.map((h) => ({ event_hash: h })), rowCount: hashes.length };
      }
      if (text.includes("UPDATE audit_verifier_checkpoint")) {
        if (text.includes("completed_passes = completed_passes + 1")) {
          // Wrap: params = [verifierName, rootMismatches, cleanPass ? "clean" : "failed"].
          passStatus = params[2] as "clean" | "failed";
          cursorPeriodEnd = null;
          cursorAnchorId = null;
          passFailureAccum = 0;
          if (passStatus === "clean") hasHadCleanPass = true;
        } else {
          // Page-advance: params = [verifierName, period_end, id, rootMismatches, passFailuresSoFar].
          cursorPeriodEnd = params[1] as Date;
          cursorAnchorId = params[2] as string;
          passFailureAccum = params[4] as number;
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 }; // BEGIN / INSERT checkpoint / INSERT finding / COMMIT
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: async () => client,
    query: vi.fn(async (text: string) => {
      sql.push(text);
      if (text.includes("last_pass_status")) {
        return {
          rows: [
            {
              last_pass_status: passStatus,
              seconds_since_clean: hasHadCleanPass ? 0 : null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as Pool;
  return { pool, sql, seenTenantIds };
}

describe("verifyAnchorRoots (durable keyset cursor)", () => {
  it("verifies the oldest page on the first cycle and continues past it (not re-checking) on the second", async () => {
    const leavesA = [1, 2].map((n) => Buffer.alloc(32, n));
    const leavesB = [3, 4].map((n) => Buffer.alloc(32, n));
    const anchorA: FakeAnchorRow = {
      id: "anchor_a",
      tenant_id: "tnt_a",
      merkle_root: buildTree(leavesA).root,
      event_count: 2,
      period_start: new Date("2026-01-01T00:00:00Z"),
      period_end: new Date("2026-01-02T00:00:00Z"),
    };
    const anchorB: FakeAnchorRow = {
      id: "anchor_b",
      tenant_id: "tnt_b",
      merkle_root: buildTree(leavesB).root,
      event_count: 2,
      period_start: new Date("2026-01-03T00:00:00Z"),
      period_end: new Date("2026-01-04T00:00:00Z"),
    };
    const { pool, seenTenantIds } = fakeAnchorRootCursorPool({
      anchors: [anchorA, anchorB],
      eventsByAnchor: { anchor_a: leavesA, anchor_b: leavesB },
      pageSize: 1,
    });

    const cycle1 = await verifyAnchorRoots({ privilegedPool: pool, anchorScanLimit: 1 });
    expect(cycle1.anchorsVerified).toBe(1);
    expect(cycle1.rootMismatches).toBe(0);
    expect(seenTenantIds).toEqual(["tnt_a"]);

    const cycle2 = await verifyAnchorRoots({ privilegedPool: pool, anchorScanLimit: 1 });
    expect(cycle2.anchorsVerified).toBe(1);
    // The stored cursor moved past anchor_a: cycle 2 checks anchor_b, not a repeat of anchor_a.
    expect(seenTenantIds).toEqual(["tnt_a", "tnt_b"]);
  });

  it("wraps the cursor to the start after a short page (advancing completed_passes), so the next cycle re-verifies from the beginning", async () => {
    const leaves = [1, 2].map((n) => Buffer.alloc(32, n));
    const anchor: FakeAnchorRow = {
      id: "anchor_only",
      tenant_id: "tnt_only",
      merkle_root: buildTree(leaves).root,
      event_count: 2,
      period_start: new Date("2026-01-01T00:00:00Z"),
      period_end: new Date("2026-01-02T00:00:00Z"),
    };
    const { pool, seenTenantIds } = fakeAnchorRootCursorPool({
      anchors: [anchor],
      eventsByAnchor: { anchor_only: leaves },
      pageSize: 25,
    });

    const cycle1 = await verifyAnchorRoots({ privilegedPool: pool });
    expect(cycle1.completedPass).toBe(true); // 1 row < pageSize 25 -> wrapped already
    expect(cycle1.anchorsVerified).toBe(1);

    const cycle2 = await verifyAnchorRoots({ privilegedPool: pool });
    // Cursor wrapped to NULL, not left pointing past the only anchor, so it is
    // re-verified rather than skipped.
    expect(cycle2.anchorsVerified).toBe(1);
    expect(seenTenantIds).toEqual(["tnt_only", "tnt_only"]);
  });

  it("ends a pass with a failed status (and never advances the clean-pass gauge) when any page has a mismatch", async () => {
    const leaves = [1, 2, 3].map((n) => Buffer.alloc(32, n));
    const storedRoot = buildTree(leaves).root; // anchor was built from all 3 rows
    const anchor: FakeAnchorRow = {
      id: "anchor_bad",
      tenant_id: "tnt_bad",
      merkle_root: storedRoot,
      event_count: 3,
      period_start: new Date("2026-01-01T00:00:00Z"),
      period_end: new Date("2026-01-02T00:00:00Z"),
    };
    const { pool, sql } = fakeAnchorRootCursorPool({
      anchors: [anchor],
      eventsByAnchor: { anchor_bad: leaves.slice(0, 2) }, // newest row missing -> mismatch
      pageSize: 25,
    });
    const metrics = { gauge: vi.fn(), increment: vi.fn(), histogram: vi.fn(), duration: vi.fn() };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await verifyAnchorRoots({ privilegedPool: pool, metrics: metrics as never });

    expect(res.completedPass).toBe(true);
    expect(res.rootMismatches).toBe(1);
    expect(sql.some((s) => s.includes("INSERT INTO audit_integrity_findings"))).toBe(true);
    expect(metrics.gauge).toHaveBeenCalledWith(
      "brain.audit.consistency.anchor_root_last_pass_clean",
      0,
    );
    // Never had a clean pass, so the seconds-since-clean gauge is never emitted
    // (last_clean_pass_at was never advanced by this failed pass).
    expect(
      metrics.gauge.mock.calls.some(
        ([name]) => name === "brain.audit.consistency.anchor_root_seconds_since_clean_full_pass",
      ),
    ).toBe(false);
    errSpy.mockRestore();
  });

  it("only selects confirmed on-chain anchors, so pending and reverted rows are skipped", async () => {
    const { pool, sql } = fakeAnchorRootCursorPool({
      anchors: [],
      eventsByAnchor: {},
      pageSize: 25,
    });

    const res = await verifyAnchorRoots({ privilegedPool: pool });

    expect(res).toEqual({
      anchorsVerified: 0,
      rootMismatches: 0,
      completedPass: true,
      currentPassFailureCount: 0,
    });
    const anchorQuery = sql.find((s) => s.startsWith("SELECT id, tenant_id, merkle_root"));
    expect(anchorQuery).toBeDefined();
    expect(anchorQuery).toContain("onchain_tx_hash IS NOT NULL");
    expect(anchorQuery).toContain("onchain_status = 'confirmed'");
  });
});

describe("reportVerifierHealth", () => {
  function healthPool(opts: {
    checkpoint?: Record<string, unknown> | null;
    anchorCheckpoint?: Record<string, unknown> | null;
    open?: number;
  }): Pool {
    return {
      query: vi.fn(async (text: string, params?: unknown[]) => {
        // F-1 regression lock: the health reader must NEVER scan audit_events —
        // the version counts come from the checkpoint, where the verifier
        // persisted them. A per-request scan of the largest table is the bug.
        if (text.includes("FROM audit_events")) {
          throw new Error("reportVerifierHealth must not query audit_events");
        }
        if (text.includes("FROM audit_verifier_checkpoint")) {
          // Two separate rows, one per verifier_name -- branch on the bound
          // param so the content-hash and anchor-root reads don't collide.
          const verifierName = (params ?? [])[0];
          const row =
            verifierName === ANCHOR_ROOT_VERIFIER_NAME
              ? (opts.anchorCheckpoint ?? opts.checkpoint)
              : opts.checkpoint;
          return { rows: row === null || row === undefined ? [] : [row], rowCount: 1 };
        }
        if (text.includes("FROM audit_integrity_findings")) {
          return { rows: [{ n: String(opts.open ?? 0) }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as Pool;
  }

  it("maps a clean checkpoint + persisted counts into a side-effect-free snapshot", async () => {
    const pool = healthPool({
      checkpoint: {
        last_pass_status: "clean",
        last_clean_pass_at: new Date("2026-06-08T00:00:00.000Z"),
        last_failed_pass_at: null,
        last_full_pass_at: new Date("2026-06-08T00:00:00.000Z"),
        completed_passes: "7",
        current_pass_failure_count: "0",
        unsupported_version_count: "0",
        legacy_unverifiable_count: "3",
        seconds_since_clean: 12,
      },
      open: 0,
    });
    const h = await reportVerifierHealth({ privilegedPool: pool });
    expect(h.lastPassStatus).toBe("clean");
    expect(h.lastCleanPassAt).toBe("2026-06-08T00:00:00.000Z");
    expect(h.completedPasses).toBe(7);
    expect(h.secondsSinceCleanFullPass).toBe(12);
    expect(h.openFindings).toBe(0);
    // Version-coverage counts come from the checkpoint (persisted by the
    // verifier cycle), not from a live audit_events scan.
    expect(h.legacyUnverifiable).toBe(3);
    expect(h.unsupportedVersion).toBe(0);
  });

  it("reads the anchor-root verifier's pass state from its OWN checkpoint row, distinct from content-hash", async () => {
    const pool = healthPool({
      checkpoint: {
        last_pass_status: "clean",
        last_clean_pass_at: new Date("2026-06-08T00:00:00.000Z"),
        last_failed_pass_at: null,
        last_full_pass_at: new Date("2026-06-08T00:00:00.000Z"),
        completed_passes: "7",
        current_pass_failure_count: "0",
        unsupported_version_count: "0",
        legacy_unverifiable_count: "3",
        seconds_since_clean: 12,
      },
      anchorCheckpoint: {
        last_pass_status: "failed",
        last_clean_pass_at: null,
        last_full_pass_at: new Date("2026-07-01T00:00:00.000Z"),
        completed_passes: "2",
        current_pass_failure_count: "1",
        seconds_since_clean: null,
      },
      open: 0,
    });
    const h = await reportVerifierHealth({ privilegedPool: pool });
    // Content-hash verifier's own state is untouched by the anchor row.
    expect(h.lastPassStatus).toBe("clean");
    expect(h.completedPasses).toBe(7);
    // The anchor-root sub-object reflects its OWN, different row.
    expect(h.anchorRoot.lastPassStatus).toBe("failed");
    expect(h.anchorRoot.lastCleanPassAt).toBeNull();
    expect(h.anchorRoot.lastFullPassAt).toBe("2026-07-01T00:00:00.000Z");
    expect(h.anchorRoot.completedPasses).toBe(2);
    expect(h.anchorRoot.currentPassFailureCount).toBe(1);
    expect(h.anchorRoot.secondsSinceCleanFullPass).toBeNull();
  });

  it("reports 'never' with null timestamps before the verifier has ever run", async () => {
    const pool = healthPool({ checkpoint: null });
    const h = await reportVerifierHealth({ privilegedPool: pool });
    expect(h.lastPassStatus).toBe("never");
    expect(h.lastCleanPassAt).toBeNull();
    expect(h.lastFullPassAt).toBeNull();
    expect(h.secondsSinceCleanFullPass).toBeNull();
    expect(h.completedPasses).toBe(0);
  });

  it("surfaces an open finding (a detected break awaiting resolution)", async () => {
    const pool = healthPool({
      checkpoint: {
        last_pass_status: "failed",
        last_clean_pass_at: null,
        last_failed_pass_at: new Date("2026-06-08T00:00:00.000Z"),
        last_full_pass_at: new Date("2026-06-08T00:00:00.000Z"),
        completed_passes: "1",
        current_pass_failure_count: "0",
        unsupported_version_count: "0",
        legacy_unverifiable_count: "0",
        seconds_since_clean: null,
      },
      open: 2,
    });
    const h = await reportVerifierHealth({ privilegedPool: pool });
    expect(h.lastPassStatus).toBe("failed");
    expect(h.openFindings).toBe(2);
    expect(h.secondsSinceCleanFullPass).toBeNull();
  });
});

describe("startAuditConsistencyVerifier", () => {
  it("emits cycle failure and last-success metrics", async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const metrics = { gauge: vi.fn(), increment: vi.fn(), histogram: vi.fn(), duration: vi.fn() };
      const failingPool = {
        query: vi.fn(async () => {
          throw new Error("db down");
        }),
      } as unknown as Pool;
      const failing = startAuditConsistencyVerifier(
        { privilegedPool: failingPool, metrics: metrics as never },
        { intervalMs: 1000 },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(metrics.increment).toHaveBeenCalledWith("brain.audit.consistency.cycle_failed.count");
      failing.stop();

      const { pool } = fakeCursorPool({ pageRows: [] });
      const healthy = startAuditConsistencyVerifier(
        { privilegedPool: pool, metrics: metrics as never },
        { intervalMs: 1000 },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(metrics.gauge).toHaveBeenCalledWith(
        "brain.audit.consistency.last_success_at",
        expect.any(Number),
      );
      healthy.stop();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
