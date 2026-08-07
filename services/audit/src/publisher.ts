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
  createLogger,
  newAuditEventId,
  withTenantScope,
  type Logger,
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

// Structured fallback for callers that do not pass their own logger (e.g.
// services/api/main.ts's scheduler passes its own; the on-demand publish
// route currently does not). Package-level singleton, same pattern
// services/api/main.ts uses for its own top-level logger -- pino is cheap to
// construct once and reuse.
const defaultLogger: Logger = createLogger({ service: "brain-audit" });

export interface BroadcastInput {
  tenantId: string;
  merkleRoot: Buffer;
  eventCount: number;
  periodStart: Date;
  periodEnd: Date;
}

/**
 * Outcome of a broadcast attempt. The broadcaster resolves (never throws) for
 * these deterministic on-chain outcomes and throws only on transient errors
 * (RPC/network), which the caller is free to retry on the next cycle:
 *   confirmed        -- tx mined status=1; AnchorPublished emitted.
 *   already_anchored -- the root was already published on-chain (skip the
 *                      redundant broadcast); txHash/blockNumber identify the
 *                      original winning tx so the DB row can be healed.
 *   reverted         -- a SINGLE-anchor tx mined status=0 (deterministic
 *                      revert), where one row is one transaction so the
 *                      revert genuinely is that row's. Terminal -- the caller
 *                      must NOT retry. txHash is the reverted tx (kept for
 *                      forensics; not persisted as a valid anchor).
 *   unresolved       -- a batch anchorBatch() call failed at the transaction
 *                      level (shared by every row in the batch, so it is not
 *                      any one row's fault), or a row's already-anchored
 *                      status could not be confirmed this cycle. NOT
 *                      terminal -- leave the row pending for a later cycle.
 */
export type BroadcastStatus = "confirmed" | "already_anchored" | "reverted" | "unresolved";

export interface BroadcastResult {
  txHash: Buffer;
  blockNumber: bigint;
  status: BroadcastStatus;
  /**
   * The contract this transaction was actually sent to, persisted on the anchor
   * row so the proof path never has to infer it from current configuration
   * (which is what mislabelled every historical proof after the 2026-08-06
   * rotation). Optional so an injected test broadcaster stays a two-line stub.
   */
  contractAddress?: string;
}

export type AnchorBroadcaster = (input: BroadcastInput) => Promise<BroadcastResult>;
export interface BroadcastBatchResult {
  input: BroadcastInput;
  result: BroadcastResult;
}
export type AnchorBatchBroadcaster = (inputs: BroadcastInput[]) => Promise<BroadcastBatchResult[]>;

export interface AnchorPublisherMetrics {
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  increment(name: string, tags?: Record<string, string>): void;
}

export interface PublishPendingAnchorBatchSummary {
  attempted: number;
  skippedTerminal: number;
  confirmed: number;
  alreadyAnchored: number;
  reverted: number;
  // Transaction-level failures (or an unresolved already-anchored lookup),
  // left pending for the next cycle rather than marked terminally reverted.
  unresolved: number;
  txCount: number;
}

/**
 * Log severity for one batch summary.
 *
 * A cycle that attempted work and published nothing is the exact signature of
 * the 2026-06/07 outage: the publisher kept logging "completed" at INFO with
 * `confirmed:0 unresolved:50` while the backlog grew for six weeks. Nothing in
 * the row states showed it either, because a transaction-level failure
 * deliberately leaves the row `pending` rather than marking it terminally
 * reverted (PR #434). Severity is therefore the only in-band signal a total
 * failure produces, and both call sites must derive it the same way.
 */
export type AnchorBatchOutcomeSeverity = "error" | "warn" | "info";

export function classifyAnchorBatchOutcome(
  summary: PublishPendingAnchorBatchSummary,
): AnchorBatchOutcomeSeverity {
  if (summary.attempted === 0) return "info";
  if (summary.confirmed + summary.alreadyAnchored === 0) return "error";
  if (summary.unresolved > 0 || summary.reverted > 0) return "warn";
  return "info";
}

/**
 * Backlog snapshot for the operator audit-health surface.
 *
 * Deliberately derived from `audit_anchors` alone rather than from the
 * publisher's in-process counters: the publisher runs in the worker container
 * and /internal/audit/health is served by the api container, so no in-memory
 * cycle state is reachable from there. The two durable columns are also the
 * two that actually detect a stall — a dead publisher shows up as a backlog
 * that only grows and an oldest-pending age that only climbs, which is exactly
 * what nobody could see for six weeks.
 *
 * Publisher wallet balance is intentionally absent for the same cross-process
 * reason; it is surfaced as a WARN log from the broadcaster instead.
 */
export interface AnchorPublisherHealth {
  /** Anchors still awaiting a successful broadcast. */
  pendingBacklogDepth: number;
  /** Age of the oldest unpublished anchor; null when the backlog is empty. */
  oldestUnanchoredAgeSeconds: number | null;
}

/** Oldest-pending age past which the publisher is treated as stalled, not busy. */
export const ANCHOR_BACKLOG_CRITICAL_AGE_SECONDS = 24 * 60 * 60;

export async function reportAnchorPublisherHealth(deps: {
  /** MUST be the BYPASSRLS privileged pool: the backlog spans every tenant. */
  privilegedPool: Pool;
}): Promise<AnchorPublisherHealth> {
  const res = await deps.privilegedPool.query<{
    pending_count: string;
    oldest_pending_age_s: number | null;
  }>(
    `SELECT COUNT(*)::text AS pending_count,
            extract(epoch FROM now() - MIN(created_at))::float8 AS oldest_pending_age_s
       FROM audit_anchors
      WHERE onchain_tx_hash IS NULL
        AND onchain_status = 'pending'`,
  );
  const row = res.rows[0];
  return {
    pendingBacklogDepth: Number(row?.pending_count ?? 0),
    oldestUnanchoredAgeSeconds: row?.oldest_pending_age_s ?? null,
  };
}

export interface PublishOptions {
  tenantId: string;
  periodStart: Date;
  periodEnd: Date;
  /** Structured logger for diagnostics. Defaults to a package-level pino
   * logger (see defaultLogger above) so callers that do not pass their own
   * still get structured, non-clear-text output. */
  logger?: Logger;
}

export async function publishAnchor(
  pool: Pool,
  broadcaster: AnchorBroadcaster,
  opts: PublishOptions,
): Promise<AuditAnchorRow | null> {
  const result = await createPendingAnchor(pool, opts);

  if (result === null) return null;
  return publishPendingAnchor(pool, broadcaster, result);
}

export async function createPendingAnchor(
  pool: Pool,
  opts: PublishOptions,
): Promise<AuditAnchorRow | null> {
  return withTenantScope(pool, opts.tenantId, async (c) => {
    const events = await listEventsForAnchor(c, opts.periodStart, opts.periodEnd);
    if (events.length === 0) return null;

    const leaves = events.map((e) => e.event_hash);
    const tree = buildTree(leaves);
    const root = tree.root;

    const existing = await findAnchorByRoot(c, root);
    if (existing !== null) {
      if (existing.onchain_status === "reverted") {
        // findAnchorByRoot has no status filter, so a genuinely reverted
        // window is found here too. Its period_end never advances
        // covered_to (the coverage query excludes reverted anchors), so the
        // SAME window recomputes to the SAME root every cycle and lands
        // here again -- returning it silently as a §5.3 no-op would make
        // that permanent with nothing in the logs to show it. Log loudly
        // instead of building a retry framework: recovering a genuinely
        // reverted window is a deliberate operator decision (the contract
        // rejected these exact events for a reason), not something to
        // auto-retry. Routed through the structured logger (not console),
        // matching how services/api/main.ts logs this same shape.
        //
        // tenantId is deliberately omitted: on the POST /audit/anchor/publish
        // path opts.tenantId traces back to the authenticated principal, and
        // CodeQL's js/clear-text-logging taints it end to end regardless of
        // sink. anchorId already uniquely identifies the row, and its tenant
        // is one `SELECT tenant_id FROM audit_anchors WHERE id = ...` away --
        // do not add tenantId back here. periodStart/periodEnd are read off
        // `existing` (the stored row) rather than `opts` for the same taint
        // reason, and it is more correct anyway: it reports what is actually
        // persisted, not the recomputed window that produced the same root.
        (opts.logger ?? defaultLogger).error(
          {
            anchorId: existing.id,
            periodStart: existing.period_start,
            periodEnd: existing.period_end,
          },
          "recomputed anchor window matches a terminally reverted anchor; it will never advance covered_to without operator intervention",
        );
      }
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
    } else if (broadcast.status !== "unresolved") {
      // confirmed | already_anchored both carry a valid on-chain anchor tx.
      await setAnchorTxHash(
        c,
        row.id,
        broadcast.txHash,
        broadcast.blockNumber,
        broadcast.contractAddress,
      );
    }
    // "unresolved" is a batch-only outcome in practice (the single-row
    // broadcaster never returns it); leave the row untouched either way.
    return findAnchorByRootLocal(c, row.merkle_root);
  });
  return finalized;
}

export async function publishPendingAnchorBatch(
  pool: Pool,
  broadcaster: AnchorBatchBroadcaster,
  rows: AuditAnchorRow[],
  metrics?: AnchorPublisherMetrics,
): Promise<PublishPendingAnchorBatchSummary> {
  const pending = rows.filter(
    (row) => row.onchain_tx_hash === null && row.onchain_status !== "reverted",
  );
  const summary: PublishPendingAnchorBatchSummary = {
    attempted: pending.length,
    skippedTerminal: rows.length - pending.length,
    confirmed: 0,
    alreadyAnchored: 0,
    reverted: 0,
    unresolved: 0,
    txCount: 0,
  };
  metrics?.gauge("brain.audit.anchor.batch_size", pending.length);
  if (pending.length === 0) return summary;

  const broadcasts = await broadcaster(
    pending.map((row) => ({
      tenantId: row.tenant_id,
      merkleRoot: row.merkle_root,
      eventCount: row.event_count,
      periodStart: row.period_start,
      periodEnd: row.period_end,
    })),
  );
  if (broadcasts.length !== pending.length) {
    throw new Error(
      `anchor batch broadcaster returned ${broadcasts.length} result(s) for ${pending.length} input(s)`,
    );
  }

  const txHashes = new Set<string>();
  for (let i = 0; i < broadcasts.length; ++i) {
    const row = pending[i];
    const broadcast = broadcasts[i]?.result;
    if (broadcast === undefined || row === undefined) {
      throw new Error("anchor batch broadcaster returned an incomplete result set");
    }
    if (broadcast.status === "unresolved") {
      // A transaction-level batch failure or an unresolved already-anchored
      // lookup -- not this row's fault. Leave it pending; the next cycle
      // retries it (same posture as InsufficientAnchorFundsError).
      summary.unresolved += 1;
      metrics?.increment("brain.audit.anchor.batch_unresolved.count");
      continue;
    }

    if (broadcast.status === "reverted") {
      summary.reverted += 1;
      await withTenantScope(pool, row.tenant_id, async (c) => {
        await setAnchorReverted(c, row.id);
      });
      continue;
    }

    if (broadcast.status === "already_anchored") {
      summary.alreadyAnchored += 1;
    } else {
      summary.confirmed += 1;
    }
    if (broadcast.txHash.length > 0) txHashes.add(broadcast.txHash.toString("hex"));
    await withTenantScope(pool, row.tenant_id, async (c) => {
      await setAnchorTxHash(
        c,
        row.id,
        broadcast.txHash,
        broadcast.blockNumber,
        broadcast.contractAddress,
      );
    });
  }
  summary.txCount = txHashes.size;
  metrics?.gauge("brain.audit.anchor.batch_tx.count", summary.txCount);
  return summary;
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
