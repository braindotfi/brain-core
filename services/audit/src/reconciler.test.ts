import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, newTenantId } from "@brain/shared";
import {
  reconcileOrphanedAnchors,
  startAnchorReconciler,
  type AnchorEventReader,
} from "./reconciler.js";

interface OrphanRow {
  id: string;
  tenant_id: string;
  merkle_root: Buffer;
  created_at: Date;
}

function fakePool(orphans: OrphanRow[]): { pool: Pool; txQueries: string[] } {
  const txQueries: string[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      txQueries.push(text.trim().split("\n")[0]!.trim());
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async (text: string) => {
      if (text.includes("audit_anchors") && text.includes("onchain_tx_hash IS NULL")) {
        return { rows: orphans, rowCount: orphans.length };
      }
      return { rows: [], rowCount: 0 };
    }),
    connect: async () => client,
  } as unknown as Pool;
  return { pool, txQueries };
}

function orphan(overrides: Partial<OrphanRow> = {}): OrphanRow {
  return {
    id: `anchor_${Math.random().toString(36).slice(2)}`,
    tenant_id: newTenantId(),
    merkle_root: Buffer.alloc(32, 7),
    created_at: new Date(),
    ...overrides,
  };
}

function readerReturning(match: { txHash: Buffer; blockNumber: bigint } | null): AnchorEventReader {
  return { findAnchorTx: vi.fn(async () => match) };
}

describe("reconcileOrphanedAnchors", () => {
  it("sets the tx hash for an orphan that has a matching on-chain anchor", async () => {
    const { pool, txQueries } = fakePool([orphan()]);
    const reader = readerReturning({ txHash: Buffer.alloc(32, 9), blockNumber: 123n });
    const audit = new InMemoryAuditEmitter();

    const res = await reconcileOrphanedAnchors({ pool, reader, audit });

    expect(res.recovered).toBe(1);
    expect(res.flagged).toBe(0);
    expect(txQueries.some((q) => q.includes("UPDATE audit_anchors SET onchain_tx_hash"))).toBe(
      true,
    );
    expect(audit.events).toHaveLength(0);
  });

  it("emits audit.anchor.orphan_detected for an unmatched orphan older than the grace window", async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago
    const { pool, txQueries } = fakePool([orphan({ created_at: old })]);
    const audit = new InMemoryAuditEmitter();

    const res = await reconcileOrphanedAnchors({ pool, reader: readerReturning(null), audit });

    expect(res.recovered).toBe(0);
    expect(res.flagged).toBe(1);
    expect(audit.events.some((e) => e.action === "audit.anchor.orphan_detected")).toBe(true);
    expect(txQueries.some((q) => q.includes("UPDATE audit_anchors SET onchain_tx_hash"))).toBe(
      false,
    );
  });

  it("does not flag a fresh unmatched orphan (still within the grace window)", async () => {
    const { pool } = fakePool([orphan({ created_at: new Date() })]);
    const audit = new InMemoryAuditEmitter();

    const res = await reconcileOrphanedAnchors({ pool, reader: readerReturning(null), audit });

    expect(res.flagged).toBe(0);
    expect(audit.events).toHaveLength(0);
  });

  it("excludes terminally reverted rows from the orphan scan", async () => {
    const selects: string[] = [];
    const pool = {
      query: vi.fn(async (text: string) => {
        selects.push(text);
        return { rows: [], rowCount: 0 };
      }),
      connect: async () => ({ query: vi.fn(), release: vi.fn() }),
    } as unknown as Pool;

    await reconcileOrphanedAnchors({
      pool,
      reader: readerReturning(null),
      audit: new InMemoryAuditEmitter(),
    });

    const scan = selects.find((s) => s.includes("FROM audit_anchors"));
    expect(scan).toBeDefined();
    expect(scan).toContain("onchain_tx_hash IS NULL");
    expect(scan).toContain("onchain_status <> 'reverted'");
  });

  it("is a no-op when there are no orphans (already-anchored rows are filtered out)", async () => {
    const { pool, txQueries } = fakePool([]);
    const reader = readerReturning({ txHash: Buffer.alloc(32, 9), blockNumber: 1n });
    const audit = new InMemoryAuditEmitter();

    const res = await reconcileOrphanedAnchors({ pool, reader, audit });

    expect(res).toEqual({ recovered: 0, flagged: 0 });
    expect(reader.findAnchorTx).not.toHaveBeenCalled();
    expect(txQueries).toHaveLength(0);
  });
});

describe("startAnchorReconciler", () => {
  it("runs a cycle immediately and on the interval, then stop() halts it", async () => {
    vi.useFakeTimers();
    try {
      const { pool } = fakePool([orphan()]);
      const reader = readerReturning({ txHash: Buffer.alloc(32, 9), blockNumber: 1n });
      const findAnchorTx = reader.findAnchorTx as ReturnType<typeof vi.fn>;
      const rec = startAnchorReconciler(
        { pool, reader, audit: new InMemoryAuditEmitter() },
        { intervalMs: 1000 },
      );

      // The immediate cycle + first interval tick both run a reconcile.
      await vi.advanceTimersByTimeAsync(1000);
      expect(findAnchorTx).toHaveBeenCalled();
      const callsBeforeStop = findAnchorTx.mock.calls.length;

      rec.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(findAnchorTx.mock.calls.length).toBe(callsBeforeStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows a cycle error so the interval keeps running", async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const pool = {
        query: vi.fn(async () => {
          throw new Error("db down");
        }),
        connect: async () => ({ query: vi.fn(), release: vi.fn() }),
      } as unknown as Pool;
      const rec = startAnchorReconciler(
        { pool, reader: readerReturning(null), audit: new InMemoryAuditEmitter() },
        { intervalMs: 1000 },
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(errSpy).toHaveBeenCalled();
      rec.stop();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
