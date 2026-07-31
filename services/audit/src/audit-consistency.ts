/**
 * Runtime audit-consistency verifier (2026-06-07 review doc #2 §6.4).
 *
 * A background detective control over the per-tenant hash chain in
 * `audit_events`. The emitter's per-tenant advisory lock PREVENTS new chain
 * forks; this verifier DETECTS any pre-fix or regressed inconsistency so an
 * integrity break is observable (metrics + a critical log) rather than silent.
 *
 * Two layers, both within the audit service's own table (no cross-service read):
 *   - STRUCTURAL (checkAuditConsistency, global each cycle): fork (two events
 *     share a predecessor), gap (a predecessor matches no event_hash), and
 *     genesis cardinality (a tenant without exactly one null-predecessor event);
 *   - CONTENT (verifyContentHashCursor, paged via a durable cursor): recompute
 *     each current-version event's canonical hash and compare to the stored one,
 *     so a mutation that left the chain structurally connected is still caught.
 *
 * A non-zero count is a P0-grade signal: the Merkle chain the on-chain anchor
 * commits to is no longer a single, faithful, linear history for that tenant.
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { AUDIT_HASH_SCHEMA_VERSION, hashEvent, startManagedInterval } from "@brain/shared";
import { buildTree } from "./merkle.js";
import type {
  AuditEventInput,
  AuditEventType,
  AuditSeverity,
  ManagedWorker,
  MetricsEmitter,
} from "@brain/shared";

export interface AuditConsistencyDeps {
  /**
   * MUST be the cross-tenant audit-verifier pool with BYPASSRLS, NOT the
   * request-path pool. The fork/gap queries scan every tenant's
   * chain and deliberately set no `app.tenant_id`; under the request role's
   * `FORCE ROW LEVEL SECURITY` that predicate (`tenant_id =
   * current_setting('app.tenant_id', true)`) matches ZERO rows, so the verifier
   * would report a permanent false-clean. Passing the privileged pool is what
   * lets this detective control actually see the data it is meant to verify.
   */
  privilegedPool: Pool;
  metrics?: MetricsEmitter;
  /**
   * Page size for verifyContentHashCursor: rows recomputed-and-compared per cycle
   * as the durable cursor advances through current-version events. Bounds the
   * cost on large tables. Default 1000.
   */
  hashScanLimit?: number;
  /**
   * Page size for verifyAnchorRoots: confirmed anchors re-verified per cycle as
   * its durable cursor advances oldest-first through audit_anchors. Kept small
   * relative to hashScanLimit because each anchor costs a full window scan
   * (audit_events) PLUS a Merkle tree build, not a single cheap row recompute.
   * Default 25.
   */
  anchorScanLimit?: number;
}

export interface AuditConsistencyResult {
  /** Distinct (tenant, predecessor) groups with more than one successor — a fork. */
  forks: number;
  /** Events whose prev_event_hash references no event_hash for the same tenant. */
  gaps: number;
  /**
   * Non-empty tenants whose count of genesis (null-predecessor) events is not
   * exactly one. Two genesis events escape both the fork check (which excludes
   * null predecessors) and the gap check (each genesis is self-consistent), so a
   * forked or duplicated chain head is otherwise invisible.
   */
  invalidGenesis: number;
}

export async function checkAuditConsistency(
  deps: AuditConsistencyDeps,
): Promise<AuditConsistencyResult> {
  // Fork: >1 event for one tenant chained off the same predecessor.
  const forkRes = await deps.privilegedPool.query<{ n: string }>(
    `SELECT count(*)::bigint AS n FROM (
       SELECT tenant_id, prev_event_hash
         FROM audit_events
        WHERE prev_event_hash IS NOT NULL
        GROUP BY tenant_id, prev_event_hash
       HAVING count(*) > 1
     ) forks`,
  );
  const forks = Number(forkRes.rows[0]?.n ?? 0);

  // Gap: an event whose predecessor hash is not the event_hash of any event for
  // the same tenant — a broken chain link (a missing or mismatched predecessor).
  const gapRes = await deps.privilegedPool.query<{ n: string }>(
    `SELECT count(*)::bigint AS n
       FROM audit_events e
      WHERE e.prev_event_hash IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM audit_events p
           WHERE p.tenant_id = e.tenant_id
             AND p.event_hash = e.prev_event_hash
        )`,
  );
  const gaps = Number(gapRes.rows[0]?.n ?? 0);

  // Genesis cardinality: a healthy non-empty tenant has EXACTLY ONE event with a
  // null predecessor. A tenant with no events contributes no row here and is
  // correctly not flagged; one with two genesis events (legacy or corrupted) or
  // zero (a missing chain head) is.
  const genesisRes = await deps.privilegedPool.query<{ n: string }>(
    `SELECT count(*)::bigint AS n FROM (
       SELECT tenant_id
         FROM audit_events
        GROUP BY tenant_id
       HAVING count(*) FILTER (WHERE prev_event_hash IS NULL) <> 1
     ) invalid_genesis`,
  );
  const invalidGenesis = Number(genesisRes.rows[0]?.n ?? 0);

  deps.metrics?.gauge("brain.audit.consistency.fork.count", forks);
  deps.metrics?.gauge("brain.audit.consistency.gap.count", gaps);
  deps.metrics?.gauge("brain.audit.consistency.invalid_genesis.count", invalidGenesis);
  if (forks > 0 || gaps > 0 || invalidGenesis > 0) {
    console.error("[audit-consistency] per-tenant hash-chain structural inconsistency detected", {
      forks,
      gaps,
      invalidGenesis,
    });
  }
  return { forks, gaps, invalidGenesis };
}

/** Stable name for the content-hash verifier's durable cursor row. */
export const CONTENT_HASH_VERIFIER_NAME = "content_hash";

export interface ContentHashVerifyResult {
  /** Rows recomputed-and-compared this cycle. */
  rowsVerified: number;
  /** Of those, how many whose recomputed hash != stored event_hash. */
  hashMismatches: number;
  /** Rows at a version NEWER than this build can verify (written by a newer deploy). */
  unsupportedVersion: number;
  /**
   * Rows at a version OLDER than the current scheme (e.g. pre-versioning v0) that
   * this build cannot recompute, so content verification does NOT cover them. A
   * disclosed blind spot, not a break: these rows are still covered by the
   * structural fork/gap/genesis checks, just not by hash recomputation. Surfaced
   * (count + gauge) so the coverage gap is explicit, never silently assumed clean
   * (Codex 307161b P2 #5).
   */
  legacyUnverifiable: number;
  /** STICKY count of OPEN integrity findings across all cycles (not just this page). */
  openFindings: number;
  /** True when this cycle's page reached the end and the cursor wrapped. */
  completedPass: boolean;
  /**
   * True when the most recently COMPLETED full pass found zero mismatches on every
   * page. A pass that found a mismatch on any page is `false`, even though it still
   * advanced completed_passes/last_full_pass_at — so "a pass finished" is not
   * mistaken for "the chain verified clean" (Codex 9389568 P2).
   */
  lastPassClean: boolean;
  /** Mismatches accumulated across the IN-PROGRESS pass so far; reset to 0 at each wrap. */
  currentPassFailureCount: number;
}

/**
 * Content-hash verification via a DURABLE CURSOR (Codex fca9ac8 P1 #2). Each call
 * pages through the next `hashScanLimit` current-version events in stable
 * (created_at, id) order, recomputes the canonical hash, compares to the stored
 * one, and advances the checkpoint transactionally — wrapping to the beginning
 * after a full pass. Over successive cycles EVERY current-version event is
 * verified, not just the newest N. A content mutation (privileged tamper /
 * migration defect) that the structural fork/gap/genesis checks cannot see is
 * therefore eventually caught.
 *
 * COVERAGE BOUNDARY (disclosed, not silent — Codex 307161b P2 #5): content
 * recomputation only covers rows at the CURRENT hash_schema_version. Rows at a
 * NEWER version (newer deploy) and at an OLDER version (pre-versioning v0) cannot
 * be recomputed by this build, so they are counted and gauged separately
 * (`unsupportedVersion` / `legacyUnverifiable`) instead of being implicitly
 * treated as verified. Both populations remain covered by the structural checks.
 * See docs/audit/runtime/consistency-verifier.md.
 */
export async function verifyContentHashCursor(
  deps: AuditConsistencyDeps,
): Promise<ContentHashVerifyResult> {
  const pageSize = deps.hashScanLimit ?? 1000;

  // Version-coverage counts, computed ONCE per cycle and persisted on the
  // checkpoint below so the health endpoint never scans audit_events itself
  // (Fable-5 F-1). Two separate queries on purpose: the 0009 index is partial
  // (WHERE hash_schema_version > 0), so the unsupported (> current) count can
  // use it while the legacy (< current) count cannot; a combined FILTER form
  // would force a full scan for both. Run BEFORE the transaction so the
  // FOR UPDATE checkpoint lock is never held across a table scan.
  const unsupportedRes = await deps.privilegedPool.query<{ n: string }>(
    `SELECT count(*)::bigint AS n FROM audit_events WHERE hash_schema_version > $1`,
    [AUDIT_HASH_SCHEMA_VERSION],
  );
  const unsupportedVersion = Number(unsupportedRes.rows[0]?.n ?? 0);
  // Rows written by an OLDER scheme (e.g. the pre-versioning v0 default) cannot
  // be recomputed by this build. NOT a break (structural checks still cover
  // them) but a disclosed content-verification blind spot (Codex 307161b P2 #5).
  const legacyRes = await deps.privilegedPool.query<{ n: string }>(
    `SELECT count(*)::bigint AS n FROM audit_events WHERE hash_schema_version < $1`,
    [AUDIT_HASH_SCHEMA_VERSION],
  );
  const legacyUnverifiable = Number(legacyRes.rows[0]?.n ?? 0);

  const c = await deps.privilegedPool.connect();
  let result: ContentHashVerifyResult;
  try {
    await c.query("BEGIN");
    // Ensure + lock the cursor row; a version bump resets the keyset position.
    await c.query(
      `INSERT INTO audit_verifier_checkpoint (verifier_name, hash_schema_version)
         VALUES ($1, $2) ON CONFLICT (verifier_name) DO NOTHING`,
      [CONTENT_HASH_VERIFIER_NAME, AUDIT_HASH_SCHEMA_VERSION],
    );
    const cpRes = await c.query<{
      hash_schema_version: number;
      last_created_at: Date | null;
      last_event_id: string | null;
      current_pass_failure_count: string | number;
    }>(
      `SELECT hash_schema_version, last_created_at, last_event_id, current_pass_failure_count
         FROM audit_verifier_checkpoint WHERE verifier_name = $1 FOR UPDATE`,
      [CONTENT_HASH_VERIFIER_NAME],
    );
    const cp = cpRes.rows[0];
    const versionChanged = cp === undefined || cp.hash_schema_version !== AUDIT_HASH_SCHEMA_VERSION;
    const lastCreatedAt = versionChanged ? null : cp.last_created_at;
    const lastEventId = versionChanged ? null : cp.last_event_id;
    // A version bump restarts the pass, so its accumulated failure count resets too.
    const priorPassFailures = versionChanged ? 0 : Number(cp?.current_pass_failure_count ?? 0);

    // Next page after the cursor, in stable keyset order.
    const page = await c.query<{
      id: string;
      tenant_id: string;
      layer: AuditEventInput["layer"];
      event_type: AuditEventType;
      severity: AuditSeverity;
      actor: string;
      actor_display_name: string | null;
      actor_email: string | null;
      action: string;
      inputs: Record<string, unknown>;
      outputs: Record<string, unknown>;
      policy_version: number | null;
      policy_decision_id: string | null;
      policy_check_id: string | null;
      outcome: string | null;
      before_state: Record<string, unknown> | null;
      after_state: Record<string, unknown> | null;
      key_id: string | null;
      prev_event_hash: Buffer | null;
      created_at: Date;
      event_hash: Buffer;
    }>(
      `SELECT id, tenant_id, layer, event_type, severity, actor, actor_display_name, actor_email,
              action, inputs, outputs,
              policy_version, policy_decision_id, policy_check_id, outcome, before_state, after_state,
              key_id, prev_event_hash, created_at, event_hash
         FROM audit_events
        WHERE hash_schema_version = $1
          AND ($2::timestamptz IS NULL OR (created_at, id) > ($2, $3))
        ORDER BY created_at, id
        LIMIT $4`,
      [AUDIT_HASH_SCHEMA_VERSION, lastCreatedAt, lastEventId, pageSize],
    );

    let hashMismatches = 0;
    for (const r of page.rows) {
      const recomputed = hashEvent({
        event: {
          tenantId: r.tenant_id,
          layer: r.layer,
          eventType: r.event_type,
          severity: r.severity,
          actor: r.actor,
          ...(r.actor_display_name !== null ? { actorDisplayName: r.actor_display_name } : {}),
          ...(r.actor_email !== null ? { actorEmail: r.actor_email } : {}),
          action: r.action,
          inputs: r.inputs,
          outputs: r.outputs,
          ...(r.policy_version !== null ? { policyVersion: r.policy_version } : {}),
          ...(r.policy_decision_id !== null ? { policyDecisionId: r.policy_decision_id } : {}),
          ...(r.policy_check_id !== null ? { policyCheckId: r.policy_check_id } : {}),
          ...(r.outcome !== null ? { outcome: r.outcome } : {}),
          ...(r.before_state !== null ? { beforeState: r.before_state } : {}),
          ...(r.after_state !== null ? { afterState: r.after_state } : {}),
          ...(r.key_id !== null ? { keyId: r.key_id } : {}),
        },
        id: r.id,
        createdAt: r.created_at.toISOString(),
        prevEventHash: r.prev_event_hash === null ? null : r.prev_event_hash.toString("hex"),
      });
      if (recomputed !== r.event_hash.toString("hex")) {
        hashMismatches += 1;
        // Record a DURABLE finding (at most one OPEN per verifier+event) so the
        // break stays visible after a later clean page resets the per-page gauge.
        await c.query(
          `INSERT INTO audit_integrity_findings
             (id, event_id, tenant_id, verifier_name, hash_schema_version, expected_hash, observed_hash)
           VALUES ($1, $2, $3, $4, $5, decode($6, 'hex'), $7)
           ON CONFLICT (verifier_name, event_id) WHERE status = 'open' DO NOTHING`,
          [
            `aif_${randomUUID()}`,
            r.id,
            r.tenant_id,
            CONTENT_HASH_VERIFIER_NAME,
            AUDIT_HASH_SCHEMA_VERSION,
            recomputed,
            r.event_hash,
          ],
        );
      }
    }

    // Advance the cursor (or wrap to the start after a full pass), recording this
    // cycle's failure count AND the running per-pass accumulation on the checkpoint.
    const completedPass = page.rows.length < pageSize;
    const passFailuresSoFar = priorPassFailures + hashMismatches;
    const failedAt = hashMismatches > 0 ? "now()" : "last_failed_at";
    if (completedPass) {
      // The wrap closes a full pass: it is CLEAN only if no page in the whole pass
      // found a mismatch. Advance last_clean_pass_at only then; otherwise mark the
      // pass failed and leave last_clean_pass_at stale. Reset the per-pass counter.
      const cleanPass = passFailuresSoFar === 0;
      await c.query(
        `UPDATE audit_verifier_checkpoint
            SET last_created_at = NULL, last_event_id = NULL, hash_schema_version = $2,
                completed_passes = completed_passes + 1, last_full_pass_at = now(),
                last_failure_count = $3, last_failed_at = ${failedAt},
                current_pass_failure_count = 0, last_pass_status = $4,
                last_clean_pass_at = ${cleanPass ? "now()" : "last_clean_pass_at"},
                last_failed_pass_at = ${cleanPass ? "last_failed_pass_at" : "now()"},
                unsupported_version_count = $5, legacy_unverifiable_count = $6,
                updated_at = now()
          WHERE verifier_name = $1`,
        [
          CONTENT_HASH_VERIFIER_NAME,
          AUDIT_HASH_SCHEMA_VERSION,
          hashMismatches,
          cleanPass ? "clean" : "failed",
          unsupportedVersion,
          legacyUnverifiable,
        ],
      );
    } else {
      const last = page.rows[page.rows.length - 1]!;
      await c.query(
        `UPDATE audit_verifier_checkpoint
            SET last_created_at = $2, last_event_id = $3, hash_schema_version = $4,
                last_failure_count = $5, last_failed_at = ${failedAt},
                current_pass_failure_count = $6,
                unsupported_version_count = $7, legacy_unverifiable_count = $8,
                updated_at = now()
          WHERE verifier_name = $1`,
        [
          CONTENT_HASH_VERIFIER_NAME,
          last.created_at.toISOString(),
          last.id,
          AUDIT_HASH_SCHEMA_VERSION,
          hashMismatches,
          passFailuresSoFar,
          unsupportedVersion,
          legacyUnverifiable,
        ],
      );
    }
    await c.query("COMMIT");
    result = {
      rowsVerified: page.rows.length,
      hashMismatches,
      unsupportedVersion,
      legacyUnverifiable,
      openFindings: 0,
      completedPass,
      lastPassClean: false,
      currentPassFailureCount: passFailuresSoFar,
    };
  } catch (err) {
    try {
      await c.query("ROLLBACK");
    } catch {
      /* swallow — original error wins */
    }
    throw err;
  } finally {
    c.release();
  }

  // STICKY open-findings count (cross-cycle): a detected break stays counted until
  // an operator resolves it, unlike the per-page hash_mismatch gauge.
  const openRes = await deps.privilegedPool.query<{ n: string }>(
    `SELECT count(*)::bigint AS n FROM audit_integrity_findings WHERE status = 'open'`,
  );
  result.openFindings = Number(openRes.rows[0]?.n ?? 0);

  // Pass-cleanliness: report the outcome of the most recent COMPLETED full pass and
  // how long since the chain last verified clean end-to-end. "A pass finished"
  // (completed_passes / last_full_pass_at) is NOT the same as "the chain is clean".
  const passRes = await deps.privilegedPool.query<{
    last_pass_status: string;
    current_pass_failure_count: string;
    seconds_since_clean: number | null;
  }>(
    `SELECT last_pass_status, current_pass_failure_count,
            extract(epoch FROM now() - last_clean_pass_at)::float8 AS seconds_since_clean
       FROM audit_verifier_checkpoint WHERE verifier_name = $1`,
    [CONTENT_HASH_VERIFIER_NAME],
  );
  const passRow = passRes.rows[0];
  result.lastPassClean = passRow?.last_pass_status === "clean";
  result.currentPassFailureCount = Number(passRow?.current_pass_failure_count ?? 0);

  deps.metrics?.gauge("brain.audit.consistency.hash_mismatch.count", result.hashMismatches);
  deps.metrics?.gauge("brain.audit.consistency.rows_verified.count", result.rowsVerified);
  deps.metrics?.gauge(
    "brain.audit.consistency.unsupported_version.count",
    result.unsupportedVersion,
  );
  // Disclosed coverage gap, emitted every cycle so a dashboard/alert can watch it.
  // Deliberately NOT folded into the integrity error log below: a permanent legacy
  // population is a known gap, not a per-cycle P0 break, and must not spam.
  deps.metrics?.gauge(
    "brain.audit.consistency.legacy_unverifiable.count",
    result.legacyUnverifiable,
  );
  deps.metrics?.gauge("brain.audit.consistency.open_findings.count", result.openFindings);
  // Clean/failed-pass observability (Codex 9389568 P2): 1 when the last completed
  // pass was clean, plus the in-progress failure count and the staleness of the
  // last clean pass. An alert on "last_pass_clean == 0" or a growing
  // seconds_since_clean_full_pass catches a verifier that keeps finishing passes
  // that are NOT clean — invisible if you only watch last_full_pass_at.
  deps.metrics?.gauge("brain.audit.consistency.last_pass_clean", result.lastPassClean ? 1 : 0);
  deps.metrics?.gauge(
    "brain.audit.consistency.current_pass_failure_count",
    result.currentPassFailureCount,
  );
  const secondsSinceClean = passRow?.seconds_since_clean;
  if (secondsSinceClean !== null && secondsSinceClean !== undefined) {
    deps.metrics?.gauge("brain.audit.consistency.seconds_since_clean_full_pass", secondsSinceClean);
  }
  if (result.hashMismatches > 0 || result.unsupportedVersion > 0 || result.openFindings > 0) {
    console.error("[audit-consistency] content-hash verification flagged events", {
      hashMismatches: result.hashMismatches,
      unsupportedVersion: result.unsupportedVersion,
      openFindings: result.openFindings,
      rowsVerified: result.rowsVerified,
    });
  }
  return result;
}

// Reused as BOTH the audit_integrity_findings verifier_name AND the
// audit_verifier_checkpoint row name -- one logical verifier, so the same
// string on both rows is intentional, not an accidental collision.
/** Stable name for the anchor-root verifier's findings AND its checkpoint row. */
export const ANCHOR_ROOT_VERIFIER_NAME = "anchor_root";

export interface AnchorRootVerifyResult {
  /** Confirmed on-chain anchors checked THIS cycle (one page). */
  anchorsVerified: number;
  /** Of those, how many whose window rows no longer produce the stored root. */
  rootMismatches: number;
  /** True when this cycle's page reached the end and the cursor wrapped. */
  completedPass: boolean;
  /** Mismatches accumulated across the IN-PROGRESS pass so far; reset to 0 at each wrap. */
  currentPassFailureCount: number;
}

/**
 * Recompute each verified on-chain anchor's Merkle root from the audit_events
 * rows currently in its window and compare it to the root committed on-chain.
 *
 * checkAuditConsistency and verifyContentHashCursor both pass if the newest N
 * events of a tenant's chain are deleted: the remaining chain is structurally
 * perfect and every surviving row's content hash is correct. Neither
 * recomputes a PUBLISHED anchor's root from the rows currently in its window,
 * so truncation, deletion of a middle row, and insertion into an
 * already-anchored window are all otherwise undetectable.
 *
 * DURABLE CURSOR (mirrors verifyContentHashCursor): a naive "newest N anchors"
 * scan re-checks the same rolling slice every cycle and never reaches
 * anything older -- at roughly one anchor per tenant per hour, 50 anchors is
 * about two days of history for a single tenant and less with many tenants,
 * so a truncation deep in history would be invisible unless it happened to
 * land inside that slice. Instead this pages oldest-first through
 * audit_anchors via audit_verifier_checkpoint, keyed on THIS verifier's own
 * row (verifier_name = ANCHOR_ROOT_VERIFIER_NAME), and wraps to the start
 * after a full pass, so every confirmed anchor is eventually re-verified.
 *
 * The checkpoint's last_created_at / last_event_id columns are named for the
 * content-hash verifier's (created_at, id) keyset; here they are reused as a
 * generic (period_end, id) cursor -- last_event_id holds an ANCHOR id, not an
 * event id. hash_schema_version is likewise not meaningful for anchors and is
 * only populated because the column is NOT NULL; this verifier never inspects
 * or resets on it.
 *
 * This is a cross-tenant system check and deliberately sets no
 * app.tenant_id GUC -- it runs on the privileged (brain_audit_verifier) pool,
 * so an explicit tenant_id = $n predicate on the event query is the isolation
 * boundary here, the same reason the fork/gap/genesis checks above use this
 * pool without a tenant scope.
 */
export async function verifyAnchorRoots(
  deps: AuditConsistencyDeps,
): Promise<AnchorRootVerifyResult> {
  const pageSize = deps.anchorScanLimit ?? 25;

  const c = await deps.privilegedPool.connect();
  let result: AnchorRootVerifyResult;
  try {
    await c.query("BEGIN");
    // Ensure + lock the cursor row (its own row, distinct from content_hash's).
    await c.query(
      `INSERT INTO audit_verifier_checkpoint (verifier_name, hash_schema_version)
         VALUES ($1, $2) ON CONFLICT (verifier_name) DO NOTHING`,
      [ANCHOR_ROOT_VERIFIER_NAME, AUDIT_HASH_SCHEMA_VERSION],
    );
    const cpRes = await c.query<{
      last_created_at: Date | null;
      last_event_id: string | null;
      current_pass_failure_count: string | number;
    }>(
      `SELECT last_created_at, last_event_id, current_pass_failure_count
         FROM audit_verifier_checkpoint WHERE verifier_name = $1 FOR UPDATE`,
      [ANCHOR_ROOT_VERIFIER_NAME],
    );
    const cp = cpRes.rows[0];
    // last_created_at / last_event_id here hold (period_end, anchor id), not
    // (event created_at, event id) -- see the function doc comment above.
    const lastPeriodEnd = cp?.last_created_at ?? null;
    const lastAnchorId = cp?.last_event_id ?? null;
    const priorPassFailures = Number(cp?.current_pass_failure_count ?? 0);

    // Next page after the cursor, oldest-first, restricted to anchors that
    // actually landed on chain (a root worth re-proving).
    const page = await c.query<{
      id: string;
      tenant_id: string;
      merkle_root: Buffer;
      event_count: number;
      period_start: Date;
      period_end: Date;
    }>(
      `SELECT id, tenant_id, merkle_root, event_count, period_start, period_end
         FROM audit_anchors
        WHERE onchain_tx_hash IS NOT NULL AND onchain_status = 'confirmed'
          AND ($1::timestamptz IS NULL OR (period_end, id) > ($1, $2))
        ORDER BY period_end ASC, id ASC
        LIMIT $3`,
      [lastPeriodEnd, lastAnchorId, pageSize],
    );

    let rootMismatches = 0;
    for (const anchor of page.rows) {
      // Same window, same order the publisher used to build this anchor. The
      // explicit tenant_id predicate (not RLS -- see the function doc comment
      // above) is what keeps this a per-anchor, not cross-tenant, recomputation.
      const events = await c.query<{ event_hash: Buffer }>(
        `SELECT event_hash FROM audit_events
          WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3
          ORDER BY created_at ASC, id ASC`,
        [anchor.tenant_id, anchor.period_start, anchor.period_end],
      );
      const tree = buildTree(events.rows.map((r) => r.event_hash));
      if (Buffer.compare(tree.root, anchor.merkle_root) !== 0) {
        rootMismatches += 1;
        // The count delta (stored event_count vs the current row count) is the
        // single most useful forensic signal for a truncation.
        console.error("[audit-consistency] anchor root recomputation mismatch", {
          anchorId: anchor.id,
          tenantId: anchor.tenant_id,
          storedRoot: anchor.merkle_root.toString("hex"),
          recomputedRoot: tree.root.toString("hex"),
          storedEventCount: anchor.event_count,
          currentRowCount: events.rows.length,
        });
        await c.query(
          `INSERT INTO audit_integrity_findings
             (id, event_id, tenant_id, verifier_name, hash_schema_version, expected_hash, observed_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (verifier_name, event_id) WHERE status = 'open' DO NOTHING`,
          [
            `aif_${randomUUID()}`,
            anchor.id,
            anchor.tenant_id,
            ANCHOR_ROOT_VERIFIER_NAME,
            AUDIT_HASH_SCHEMA_VERSION,
            tree.root,
            anchor.merkle_root,
          ],
        );
      }
    }

    // Advance the cursor (or wrap to the start after a full pass), recording
    // this cycle's failure count AND the running per-pass accumulation, same
    // shape as verifyContentHashCursor.
    const completedPass = page.rows.length < pageSize;
    const passFailuresSoFar = priorPassFailures + rootMismatches;
    const failedAt = rootMismatches > 0 ? "now()" : "last_failed_at";
    if (completedPass) {
      // The wrap closes a full pass: it is CLEAN only if no page in the whole
      // pass found a mismatch. Advance last_clean_pass_at only then.
      const cleanPass = passFailuresSoFar === 0;
      await c.query(
        `UPDATE audit_verifier_checkpoint
            SET last_created_at = NULL, last_event_id = NULL,
                completed_passes = completed_passes + 1, last_full_pass_at = now(),
                last_failure_count = $2, last_failed_at = ${failedAt},
                current_pass_failure_count = 0, last_pass_status = $3,
                last_clean_pass_at = ${cleanPass ? "now()" : "last_clean_pass_at"},
                last_failed_pass_at = ${cleanPass ? "last_failed_pass_at" : "now()"},
                updated_at = now()
          WHERE verifier_name = $1`,
        [ANCHOR_ROOT_VERIFIER_NAME, rootMismatches, cleanPass ? "clean" : "failed"],
      );
    } else {
      const last = page.rows[page.rows.length - 1]!;
      await c.query(
        `UPDATE audit_verifier_checkpoint
            SET last_created_at = $2, last_event_id = $3,
                last_failure_count = $4, last_failed_at = ${failedAt},
                current_pass_failure_count = $5,
                updated_at = now()
          WHERE verifier_name = $1`,
        [ANCHOR_ROOT_VERIFIER_NAME, last.period_end, last.id, rootMismatches, passFailuresSoFar],
      );
    }
    await c.query("COMMIT");
    result = {
      anchorsVerified: page.rows.length,
      rootMismatches,
      completedPass,
      currentPassFailureCount: passFailuresSoFar,
    };
  } catch (err) {
    try {
      await c.query("ROLLBACK");
    } catch {
      /* swallow -- original error wins */
    }
    throw err;
  } finally {
    c.release();
  }

  deps.metrics?.gauge("brain.audit.consistency.anchors_verified.count", result.anchorsVerified);
  deps.metrics?.gauge("brain.audit.consistency.anchor_root_mismatch.count", result.rootMismatches);

  // Pass-cleanliness gauges, same derivation as the content verifier's
  // last_pass_clean / seconds_since_clean_full_pass.
  const passRes = await deps.privilegedPool.query<{
    last_pass_status: string;
    seconds_since_clean: number | null;
  }>(
    `SELECT last_pass_status,
            extract(epoch FROM now() - last_clean_pass_at)::float8 AS seconds_since_clean
       FROM audit_verifier_checkpoint WHERE verifier_name = $1`,
    [ANCHOR_ROOT_VERIFIER_NAME],
  );
  const passRow = passRes.rows[0];
  const lastPassClean = passRow?.last_pass_status === "clean";
  deps.metrics?.gauge("brain.audit.consistency.anchor_root_last_pass_clean", lastPassClean ? 1 : 0);
  const secondsSinceClean = passRow?.seconds_since_clean;
  if (secondsSinceClean !== null && secondsSinceClean !== undefined) {
    deps.metrics?.gauge(
      "brain.audit.consistency.anchor_root_seconds_since_clean_full_pass",
      secondsSinceClean,
    );
  }

  return result;
}

/**
 * Read-only health snapshot of the content-hash verifier for an operator surface
 * (90eade5 doc 5.10). Pure: it reads the durable checkpoint + the open-findings
 * count and emits NO metrics and NO logs and mutates nothing, so it is safe to
 * call on-demand from an HTTP handler. It NEVER queries audit_events — the
 * version-coverage counts are read from the checkpoint, where the verifier
 * persists them each cycle, so a polled health endpoint costs two small reads
 * instead of a per-request scan of the largest table (Fable-5 F-1). Counts are
 * therefore as-of the last verifier cycle (≤ the verifier interval stale).
 * MUST use the privileged (BYPASSRLS) pool — the verifier tables are
 * global/RLS-exempt.
 */
export interface AuditVerifierHealth {
  /** Outcome of the most recent COMPLETED full pass; "never" until the first wrap. */
  lastPassStatus: "never" | "clean" | "failed";
  /** ISO timestamp of the last fully-clean pass, or null if there has never been one. */
  lastCleanPassAt: string | null;
  /** ISO timestamp of the last failed pass, or null. */
  lastFailedPassAt: string | null;
  /** ISO timestamp the last full pass completed (clean OR failed), or null. */
  lastFullPassAt: string | null;
  /** Total full passes the cursor has completed. */
  completedPasses: number;
  /** Mismatches accumulated in the in-progress pass so far. */
  currentPassFailureCount: number;
  /** Seconds since the last clean full pass; null if there has never been one. */
  secondsSinceCleanFullPass: number | null;
  /** Sticky count of OPEN integrity findings (a detected break awaiting resolution). */
  openFindings: number;
  /** Events at a version newer than this build can verify. */
  unsupportedVersion: number;
  /** Events at an older (e.g. pre-versioning v0) scheme this build cannot recompute. */
  legacyUnverifiable: number;
  /**
   * The anchor-root verifier's own pass state, checked into the SAME
   * audit_verifier_checkpoint table under verifier_name = "anchor_root" so a
   * stale or failing anchor-root pass is never silently omitted from the
   * operator surface just because only the content-hash verifier was read.
   */
  anchorRoot: AnchorRootVerifierHealth;
}

/**
 * Pass-state snapshot for the anchor-root verifier (see verifyAnchorRoots),
 * read from its own audit_verifier_checkpoint row. Deliberately narrower than
 * AuditVerifierHealth: unsupported/legacy hash_schema_version counts are a
 * content-hash-verifier concept and do not apply to anchors.
 */
export interface AnchorRootVerifierHealth {
  lastPassStatus: "never" | "clean" | "failed";
  lastCleanPassAt: string | null;
  lastFullPassAt: string | null;
  completedPasses: number;
  currentPassFailureCount: number;
  secondsSinceCleanFullPass: number | null;
}

export async function reportVerifierHealth(deps: {
  privilegedPool: Pool;
}): Promise<AuditVerifierHealth> {
  const cp = await deps.privilegedPool.query<{
    last_pass_status: string;
    last_clean_pass_at: Date | null;
    last_failed_pass_at: Date | null;
    last_full_pass_at: Date | null;
    completed_passes: string;
    current_pass_failure_count: string;
    unsupported_version_count: string;
    legacy_unverifiable_count: string;
    seconds_since_clean: number | null;
  }>(
    `SELECT last_pass_status, last_clean_pass_at, last_failed_pass_at, last_full_pass_at,
            completed_passes, current_pass_failure_count,
            unsupported_version_count, legacy_unverifiable_count,
            extract(epoch FROM now() - last_clean_pass_at)::float8 AS seconds_since_clean
       FROM audit_verifier_checkpoint WHERE verifier_name = $1`,
    [CONTENT_HASH_VERIFIER_NAME],
  );
  const row = cp.rows[0];

  // Same checkpoint table, the anchor-root verifier's OWN row.
  const anchorCp = await deps.privilegedPool.query<{
    last_pass_status: string;
    last_clean_pass_at: Date | null;
    last_full_pass_at: Date | null;
    completed_passes: string;
    current_pass_failure_count: string;
    seconds_since_clean: number | null;
  }>(
    `SELECT last_pass_status, last_clean_pass_at, last_full_pass_at,
            completed_passes, current_pass_failure_count,
            extract(epoch FROM now() - last_clean_pass_at)::float8 AS seconds_since_clean
       FROM audit_verifier_checkpoint WHERE verifier_name = $1`,
    [ANCHOR_ROOT_VERIFIER_NAME],
  );
  const anchorRow = anchorCp.rows[0];

  const openRes = await deps.privilegedPool.query<{ n: string }>(
    `SELECT count(*)::bigint AS n FROM audit_integrity_findings WHERE status = 'open'`,
  );

  const status = row?.last_pass_status;
  const anchorStatus = anchorRow?.last_pass_status;
  return {
    lastPassStatus: status === "clean" || status === "failed" ? status : "never",
    lastCleanPassAt: row?.last_clean_pass_at?.toISOString() ?? null,
    lastFailedPassAt: row?.last_failed_pass_at?.toISOString() ?? null,
    lastFullPassAt: row?.last_full_pass_at?.toISOString() ?? null,
    completedPasses: Number(row?.completed_passes ?? 0),
    currentPassFailureCount: Number(row?.current_pass_failure_count ?? 0),
    secondsSinceCleanFullPass:
      row?.seconds_since_clean === null || row?.seconds_since_clean === undefined
        ? null
        : row.seconds_since_clean,
    openFindings: Number(openRes.rows[0]?.n ?? 0),
    unsupportedVersion: Number(row?.unsupported_version_count ?? 0),
    legacyUnverifiable: Number(row?.legacy_unverifiable_count ?? 0),
    anchorRoot: {
      lastPassStatus:
        anchorStatus === "clean" || anchorStatus === "failed" ? anchorStatus : "never",
      lastCleanPassAt: anchorRow?.last_clean_pass_at?.toISOString() ?? null,
      lastFullPassAt: anchorRow?.last_full_pass_at?.toISOString() ?? null,
      completedPasses: Number(anchorRow?.completed_passes ?? 0),
      currentPassFailureCount: Number(anchorRow?.current_pass_failure_count ?? 0),
      secondsSinceCleanFullPass:
        anchorRow?.seconds_since_clean === null || anchorRow?.seconds_since_clean === undefined
          ? null
          : anchorRow.seconds_since_clean,
    },
  };
}

export type AuditConsistencyVerifier = ManagedWorker;

/**
 * Run the structural checks (fork/gap/genesis, global) AND advance the
 * content-hash cursor by one page, on a fixed cadence (default every 10 minutes).
 */
export function startAuditConsistencyVerifier(
  deps: AuditConsistencyDeps,
  opts: { intervalMs?: number } = {},
): AuditConsistencyVerifier {
  const intervalMs = opts.intervalMs ?? 10 * 60 * 1000;
  return startManagedInterval(
    async () => {
      await checkAuditConsistency(deps);
      await verifyContentHashCursor(deps);
      await verifyAnchorRoots(deps);
      deps.metrics?.gauge("brain.audit.consistency.last_success_at", Date.now() / 1000);
    },
    intervalMs,
    {
      name: "audit-consistency",
      runImmediately: true,
      onError: (err) => {
        deps.metrics?.increment("brain.audit.consistency.cycle_failed.count");
        console.error("[audit-consistency] cycle failed:", err);
      },
    },
  );
}
