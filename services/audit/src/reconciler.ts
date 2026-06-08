/**
 * Anchor orphan-recovery reconciler.
 *
 * publishAnchor broadcasts to the chain OUTSIDE the DB transaction that inserted
 * the anchor row, then writes the tx hash back. If the process dies between the
 * successful broadcast and setAnchorTxHash, the anchor exists on-chain but the
 * DB row keeps `onchain_tx_hash = NULL` forever. This job heals that: it scans
 * for orphaned anchors, finds the matching on-chain AnchorPublished event by
 * (tenant, root), and backfills the tx hash. Orphans with no on-chain match that
 * are older than the grace window are surfaced as `audit.anchor.orphan_detected`
 * for ops.
 *
 * The orphan scan is cross-tenant (a system job) and uses the pool directly,
 * matching the normalize worker. The per-anchor write is tenant-scoped.
 */

import { startManagedInterval, withTenantScope, type AuditEmitter } from "@brain/shared";
import type { ManagedWorker } from "@brain/shared";
import type { Pool } from "pg";
import { setAnchorTxHash } from "./repository.js";

/** Reads the on-chain AnchorPublished record for a (tenant, root), if present. */
export interface AnchorEventReader {
  findAnchorTx(query: {
    tenantId: string;
    merkleRoot: Buffer;
  }): Promise<{ txHash: Buffer; blockNumber: bigint } | null>;
}

export interface ReconcilerDeps {
  pool: Pool;
  reader: AnchorEventReader;
  audit: AuditEmitter;
}

export interface ReconcileOptions {
  /** Max orphans to process per cycle. Default 100. */
  limit?: number;
  /** Orphans unmatched on-chain past this age are flagged. Default 1h. */
  orphanGraceMs?: number;
}

interface OrphanRow {
  id: string;
  tenant_id: string;
  merkle_root: Buffer;
  created_at: Date;
}

export async function reconcileOrphanedAnchors(
  deps: ReconcilerDeps,
  opts: ReconcileOptions = {},
): Promise<{ recovered: number; flagged: number }> {
  const limit = opts.limit ?? 100;
  const graceMs = opts.orphanGraceMs ?? 60 * 60 * 1000;
  const now = Date.now();

  const { rows } = await deps.pool.query<OrphanRow>(
    `SELECT id, tenant_id, merkle_root, created_at
       FROM audit_anchors
      WHERE onchain_tx_hash IS NULL
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );

  let recovered = 0;
  let flagged = 0;

  for (const row of rows) {
    const match = await deps.reader.findAnchorTx({
      tenantId: row.tenant_id,
      merkleRoot: row.merkle_root,
    });

    if (match !== null) {
      await withTenantScope(deps.pool, row.tenant_id, (c) =>
        setAnchorTxHash(c, row.id, match.txHash, match.blockNumber),
      );
      recovered += 1;
      continue;
    }

    const ageMs = now - row.created_at.getTime();
    if (ageMs > graceMs) {
      console.warn(
        `[anchorReconciler] orphan anchor ${row.id} unmatched on-chain after ${Math.round(ageMs / 1000)}s`,
      );
      await deps.audit.emit({
        tenantId: row.tenant_id,
        layer: "audit",
        actor: "sys_anchor_reconciler",
        action: "audit.anchor.orphan_detected",
        inputs: {
          anchor_id: row.id,
          merkle_root: row.merkle_root.toString("hex"),
          age_seconds: Math.round(ageMs / 1000),
        },
        outputs: {},
      });
      flagged += 1;
    }
  }

  return { recovered, flagged };
}

export type AnchorReconciler = ManagedWorker;

/** Run reconcileOrphanedAnchors on a fixed cadence (default every 5 minutes). */
export function startAnchorReconciler(
  deps: ReconcilerDeps,
  opts: ReconcileOptions & { intervalMs?: number } = {},
): AnchorReconciler {
  const intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
  return startManagedInterval(
    async () => {
      await reconcileOrphanedAnchors(deps, opts);
    },
    intervalMs,
    {
      name: "anchor-reconciler",
      runImmediately: true,
      onError: (err) => console.error("[anchorReconciler] cycle failed:", err),
    },
  );
}
