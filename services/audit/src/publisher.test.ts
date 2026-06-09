import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Pool } from "pg";
import type * as BrainShared from "@brain/shared";
import type { AuditAnchorRow } from "./repository.js";

// withTenantScope just runs the callback with a throwaway client here — the
// repository functions it would call are mocked below, so the client is unused.
vi.mock("@brain/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof BrainShared>();
  return {
    ...actual,
    withTenantScope: vi.fn(async (_pool: unknown, _tid: string, cb: (c: unknown) => unknown) =>
      cb({ query: vi.fn() }),
    ),
  };
});

vi.mock("./repository.js", () => ({
  findAnchorByRoot: vi.fn(),
  insertAnchor: vi.fn(),
  listEventsForAnchor: vi.fn(),
  setAnchorTxHash: vi.fn(),
  setAnchorReverted: vi.fn(),
}));

import { publishAnchor, type BroadcastResult } from "./publisher.js";
import * as repo from "./repository.js";

const pool = {} as Pool;
const opts = {
  tenantId: "tnt_test",
  periodStart: new Date("2026-06-09T00:00:00Z"),
  periodEnd: new Date("2026-06-09T01:00:00Z"),
};

function anchorRow(overrides: Partial<AuditAnchorRow> = {}): AuditAnchorRow {
  return {
    id: "anchor_1",
    tenant_id: "tnt_test",
    merkle_root: Buffer.alloc(32, 3),
    event_count: 1,
    period_start: opts.periodStart,
    period_end: opts.periodEnd,
    onchain_tx_hash: null,
    onchain_block_number: null,
    onchain_status: "pending",
    created_at: new Date(),
    ...overrides,
  };
}

const broadcastResult = (status: BroadcastResult["status"]): BroadcastResult => ({
  txHash: Buffer.alloc(32, 0xab),
  blockNumber: 4242n,
  status,
});

describe("publishAnchor", () => {
  beforeEach(() => {
    vi.mocked(repo.listEventsForAnchor).mockReset();
    vi.mocked(repo.findAnchorByRoot).mockReset();
    vi.mocked(repo.insertAnchor).mockReset();
    vi.mocked(repo.setAnchorTxHash).mockReset();
    vi.mocked(repo.setAnchorReverted).mockReset();
    // Default: one event in the window so a root is computed.
    vi.mocked(repo.listEventsForAnchor).mockResolvedValue([
      { event_hash: Buffer.alloc(32, 7) } as never,
    ]);
  });

  it("returns null and never broadcasts when the window has no events", async () => {
    vi.mocked(repo.listEventsForAnchor).mockResolvedValue([]);
    const broadcaster = vi.fn();

    const res = await publishAnchor(pool, broadcaster, opts);

    expect(res).toBeNull();
    expect(broadcaster).not.toHaveBeenCalled();
    expect(repo.insertAnchor).not.toHaveBeenCalled();
  });

  it("persists tx hash + confirmed status on a confirmed broadcast", async () => {
    const pending = anchorRow();
    vi.mocked(repo.findAnchorByRoot)
      .mockResolvedValueOnce(null) // insert scope: no existing row
      .mockResolvedValueOnce(anchorRow({ onchain_tx_hash: Buffer.alloc(32, 0xab) })); // finalize read
    vi.mocked(repo.insertAnchor).mockResolvedValue(pending);
    const broadcaster = vi.fn(async () => broadcastResult("confirmed"));

    await publishAnchor(pool, broadcaster, opts);

    expect(broadcaster).toHaveBeenCalledTimes(1);
    expect(repo.setAnchorTxHash).toHaveBeenCalledWith(
      expect.anything(),
      pending.id,
      broadcastResult("confirmed").txHash,
      4242n,
    );
    expect(repo.setAnchorReverted).not.toHaveBeenCalled();
  });

  it("heals the DB row from an already_anchored broadcast (treated as confirmed)", async () => {
    const pending = anchorRow();
    vi.mocked(repo.findAnchorByRoot).mockResolvedValueOnce(null).mockResolvedValueOnce(pending);
    vi.mocked(repo.insertAnchor).mockResolvedValue(pending);
    const broadcaster = vi.fn(async () => broadcastResult("already_anchored"));

    await publishAnchor(pool, broadcaster, opts);

    expect(repo.setAnchorTxHash).toHaveBeenCalledTimes(1);
    expect(repo.setAnchorReverted).not.toHaveBeenCalled();
  });

  it("marks the row reverted (terminal) on a deterministic revert and never sets a tx hash", async () => {
    const pending = anchorRow();
    vi.mocked(repo.findAnchorByRoot).mockResolvedValueOnce(null).mockResolvedValueOnce(pending);
    vi.mocked(repo.insertAnchor).mockResolvedValue(pending);
    const broadcaster = vi.fn(async () => broadcastResult("reverted"));

    await publishAnchor(pool, broadcaster, opts);

    expect(repo.setAnchorReverted).toHaveBeenCalledWith(expect.anything(), pending.id);
    expect(repo.setAnchorTxHash).not.toHaveBeenCalled();
  });

  it("does NOT re-broadcast a row that already carries a tx hash (idempotent)", async () => {
    vi.mocked(repo.findAnchorByRoot).mockResolvedValueOnce(
      anchorRow({ onchain_tx_hash: Buffer.alloc(32, 1), onchain_status: "confirmed" }),
    );
    const broadcaster = vi.fn();

    await publishAnchor(pool, broadcaster, opts);

    expect(broadcaster).not.toHaveBeenCalled();
    expect(repo.insertAnchor).not.toHaveBeenCalled();
  });

  it("does NOT re-broadcast a terminally reverted row (stops the nonce-burn loop)", async () => {
    vi.mocked(repo.findAnchorByRoot).mockResolvedValueOnce(
      anchorRow({ onchain_tx_hash: null, onchain_status: "reverted" }),
    );
    const broadcaster = vi.fn();

    await publishAnchor(pool, broadcaster, opts);

    expect(broadcaster).not.toHaveBeenCalled();
  });
});
