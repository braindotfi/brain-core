/**
 * Audit anchor publisher — hourly cadence per §3 Layer 5.
 *
 * Flow per tenant per window:
 *   1. Collect audit_events rows in [periodStart, periodEnd).
 *   2. Compute Merkle root using each row's event_hash as a leaf.
 *   3. Insert audit_anchors row (pending tx).
 *   4. Call BrainAuditAnchor.anchor(tenantId, root, eventCount, periodStart, periodEnd).
 *   5. Record tx hash + block number on the anchor row.
 *
 * Idempotency: §5.3 — the publisher tracks the last published root per
 * tenant (via the UNIQUE (tenant_id, merkle_root) index plus a lookup
 * before insert). Re-running with the same events for the same window
 * is safe; re-inserting the same root is a no-op.
 *
 * The actual broadcast is injected via `broadcastAnchor` so unit tests
 * don't need a live RPC. The BullMQ worker at stage-8 wires this to
 * viem.writeContract against BrainAuditAnchor on Base.
 */

import {
  brainError,
  newAuditEventId,
  withTenantScope,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";
import { buildTree } from "./merkle.js";
import {
  findAnchorByRoot,
  insertAnchor,
  listEventsForAnchor,
  setAnchorReverted,
  setAnchorTxHash,
  type AuditAnchorRow,
} from "./repository.js";

export interface BroadcastInput {
  tenantId: string;
  merkleRoot: Buffer;
  eventCount: number;
  periodStart: Date;
  periodEnd: Date;
}

/**
 * Outcome of a broadcast attempt. The broadcaster resolves (never throws) for
 * the three deterministic on-chain outcomes and throws only on transient errors
 * (RPC/network), which the caller is free to retry on the next cycle:
 *   confirmed        — tx mined status=1; AnchorPublished emitted.
 *   already_anchored — the root was already published on-chain (skip the
 *                      redundant broadcast); txHash/blockNumber identify the
 *                      original winning tx so the DB row can be healed.
 *   reverted         — tx mined status=0 (deterministic revert). Terminal — the
 *                      caller must NOT retry. txHash is the reverted tx (kept
 *                      for forensics; not persisted as a valid anchor).
 */
export type BroadcastStatus = "confirmed" | "already_anchored" | "reverted";

export interface BroadcastResult {
  txHash: Buffer;
  blockNumber: bigint;
  status: BroadcastStatus;
}

export type AnchorBroadcaster = (input: BroadcastInput) => Promise<BroadcastResult>;

export interface PublishOptions {
  tenantId: string;
  periodStart: Date;
  periodEnd: Date;
}

export async function publishAnchor(
  pool: Pool,
  broadcaster: AnchorBroadcaster,
  opts: PublishOptions,
): Promise<AuditAnchorRow | null> {
  const result = await withTenantScope(pool, opts.tenantId, async (c) => {
    const events = await listEventsForAnchor(c, opts.periodStart, opts.periodEnd);
    if (events.length === 0) return null;

    const leaves = events.map((e) => e.event_hash);
    const tree = buildTree(leaves);
    const root = tree.root;

    const existing = await findAnchorByRoot(c, root);
    if (existing !== null) {
      // §5.3 no-op.
      return existing;
    }

    const inserted = await insertAnchor(c, {
      id: anchorId(),
      tenantId: opts.tenantId,
      merkleRoot: root,
      eventCount: events.length,
      periodStart: opts.periodStart,
      periodEnd: opts.periodEnd,
    });
    return inserted;
  });

  if (result === null) return null;
  return publishPendingAnchor(pool, broadcaster, result);
}

export async function publishPendingAnchor(
  pool: Pool,
  broadcaster: AnchorBroadcaster,
  row: AuditAnchorRow,
): Promise<AuditAnchorRow | null> {
  // Nothing more to do for a row that already reached a terminal state:
  //   - onchain_tx_hash set means confirmed, a valid anchor tx mined, or
  //   - onchain_status reverted means the contract rejected this window for good.
  if (row.onchain_tx_hash !== null || row.onchain_status === "reverted") {
    return row;
  }
  const broadcast = await broadcaster({
    tenantId: row.tenant_id,
    merkleRoot: row.merkle_root,
    eventCount: row.event_count,
    periodStart: row.period_start,
    periodEnd: row.period_end,
  });

  const finalized = await withTenantScope(pool, row.tenant_id, async (c) => {
    if (broadcast.status === "reverted") {
      // Deterministic on-chain revert. Record it and stop retrying.
      await setAnchorReverted(c, row.id);
    } else {
      // confirmed | already_anchored both carry a valid on-chain anchor tx.
      await setAnchorTxHash(c, row.id, broadcast.txHash, broadcast.blockNumber);
    }
    return findAnchorByRootLocal(c, row.merkle_root);
  });
  return finalized;
}

async function findAnchorByRootLocal(
  c: TenantScopedClient,
  root: Buffer,
): Promise<AuditAnchorRow | null> {
  return findAnchorByRoot(c, root);
}

function anchorId(): string {
  // Reuse the audit event id prefix factory — anchors share the `evt_`
  // namespace for MVP (we can split the prefix later without breaking
  // wire compatibility since external consumers reach anchors via
  // different endpoints).
  return newAuditEventId().replace(/^evt_/, "anchor_");
}

export function guardTenantId(tenantId: string): void {
  if (!tenantId.startsWith("tnt_")) {
    throw brainError("auth_tenant_mismatch", "malformed tenant id");
  }
}
