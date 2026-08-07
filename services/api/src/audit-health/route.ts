/**
 * Operator audit-health endpoint (90eade5 doc 5.10).
 *
 *   GET /internal/audit/health   (auth required; scope audit:admin)
 *
 * A read-only, side-effect-free snapshot that makes the audit verifier's trust
 * state queryable on demand (alongside the gauges the verifier already emits):
 * the content-hash verifier's clean/failed pass status + staleness, sticky open
 * integrity findings, version-coverage counts, and audit-evidence outbox health.
 * It rolls those into a single safe/degraded/critical status so an operator (or a
 * dashboard/alert) can answer "is the audit trail currently trustworthy?".
 *
 * Scope: this returns PLATFORM-GLOBAL operational aggregates (counts + timestamps,
 * never tenant payloads or hashes), so it is gated on the strongest audit scope,
 * `audit:admin`. A dedicated platform-operator scope would be the cleaner long-term
 * gate, but none exists in the scope vocabulary yet.
 *
 * Root-mounted (not under /v1) like /health, so it stays an internal operational
 * surface outside the public OpenAPI contract.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, requireScope, type Scope } from "@brain/shared";
import type { Pool } from "pg";
import {
  reportVerifierHealth,
  reportAnchorPublisherHealth,
  ANCHOR_STALL_INTERVAL_MULTIPLE,
  type AuditVerifierHealth,
  type AnchorPublisherHealth,
} from "@brain/audit";
import {
  reportAuditOutboxHealth,
  type AuditOutboxHealth,
} from "../tenant-deletion/blob-purge-audit-outbox.js";

const ADMIN: Scope = "audit:admin";
export const AUDIT_VERIFIER_STALE_AFTER_SECONDS = 30 * 60;

export interface AuditHealthRouteDeps {
  /** MUST be the BYPASSRLS privileged pool: the queries span every tenant. */
  privilegedPool: Pool;
  /**
   * The anchor publisher's cycle interval. The stall threshold is a multiple
   * of it rather than an independent constant, so changing the cadence cannot
   * silently leave the alarm calibrated for the old one.
   */
  anchorIntervalMs: number;
}

export type AuditHealthStatus = "safe" | "degraded" | "critical";

export interface AuditHealthResponse {
  status: AuditHealthStatus;
  verifier: AuditVerifierHealth;
  outbox: AuditOutboxHealth;
  anchorPublisher: AnchorPublisherHealth;
}

/**
 * Roll the two snapshots into one operator-facing status. The content-hash and
 * anchor-root verifiers are checked SYMMETRICALLY (same rules, same
 * AUDIT_VERIFIER_STALE_AFTER_SECONDS threshold, reused rather than a second
 * one invented) so a stale or failing anchor-root pass rolls up exactly like a
 * stale or failing content-hash pass:
 *   critical: an active integrity break or undelivered mandatory evidence:
 *              a failed last pass (either verifier), any open finding,
 *              exhausted outbox row, or a stale clean-pass heartbeat (either
 *              verifier).
 *   degraded: no clean pass yet (either verifier), missing staleness data, or
 *              events this build cannot content-verify.
 *   safe: both verifiers' last pass clean, no open findings, no exhausted
 *          evidence.
 */
export function deriveAuditHealthStatus(
  verifier: AuditVerifierHealth,
  outbox: AuditOutboxHealth,
  anchorPublisher: AnchorPublisherHealth,
  /**
   * Default matches the pinned one-hour AUDIT_ANCHOR_INTERVAL_MS. The route
   * always passes the configured value; the default exists so a caller that
   * does not care about the publisher does not have to compute it.
   */
  anchorStallAfterSeconds: number = ANCHOR_STALL_INTERVAL_MULTIPLE * 60 * 60,
): AuditHealthStatus {
  const anchorRoot = verifier.anchorRoot;
  if (
    verifier.lastPassStatus === "failed" ||
    anchorRoot.lastPassStatus === "failed" ||
    verifier.openFindings > 0 ||
    outbox.exhausted > 0
  ) {
    return "critical";
  }
  // A stalled publisher is an active break in the on-chain claim, not a
  // degradation: while it holds, §4's "anchored and tamper-evident" wording is
  // false. Stalled means "there is work waiting AND nothing has landed on-chain
  // for several cycles", never "the oldest pending row is old". The latter is
  // permanently true in production (a 172,329-row backlog whose head is from
  // 2026-06-05) and would pin this endpoint to critical for months, which is
  // how a signal stops being read.
  if (
    anchorPublisher.pendingBacklogDepth > 0 &&
    anchorPublisher.secondsSinceLastLandedAnchor !== null &&
    anchorPublisher.secondsSinceLastLandedAnchor > anchorStallAfterSeconds
  ) {
    return "critical";
  }
  if (
    verifier.lastPassStatus === "clean" &&
    verifier.secondsSinceCleanFullPass !== null &&
    verifier.secondsSinceCleanFullPass > AUDIT_VERIFIER_STALE_AFTER_SECONDS
  ) {
    return "critical";
  }
  if (
    anchorRoot.lastPassStatus === "clean" &&
    anchorRoot.secondsSinceCleanFullPass !== null &&
    anchorRoot.secondsSinceCleanFullPass > AUDIT_VERIFIER_STALE_AFTER_SECONDS
  ) {
    return "critical";
  }
  if (
    verifier.lastPassStatus === "never" ||
    verifier.secondsSinceCleanFullPass === null ||
    verifier.unsupportedVersion > 0 ||
    verifier.legacyUnverifiable > 0 ||
    anchorRoot.lastPassStatus === "never" ||
    anchorRoot.secondsSinceCleanFullPass === null ||
    // Work waiting and the publisher has never landed anything. Distinct from
    // stalled: a fresh environment sits here legitimately until its first
    // cycle, so it must not page, but it must not read as safe either.
    (anchorPublisher.pendingBacklogDepth > 0 &&
      anchorPublisher.secondsSinceLastLandedAnchor === null)
  ) {
    return "degraded";
  }
  return "safe";
}

export function registerAuditHealthRoute(app: FastifyInstance, deps: AuditHealthRouteDeps): void {
  app.get("/internal/audit/health", async (request: FastifyRequest, reply) => {
    if (request.principal === undefined) {
      throw brainError("auth_token_missing", "principal required");
    }
    requireScope(request.principal.scopes, ADMIN);

    const [verifier, outbox, anchorPublisher] = await Promise.all([
      reportVerifierHealth({ privilegedPool: deps.privilegedPool }),
      // quiet: a polled endpoint must not emit a critical log line per poll;
      // the worker-cycle caller keeps the loud default (Fable-5 F-3).
      reportAuditOutboxHealth({ privilegedPool: deps.privilegedPool, quiet: true }),
      reportAnchorPublisherHealth({ privilegedPool: deps.privilegedPool }),
    ]);

    reply.status(200);
    const body: AuditHealthResponse = {
      status: deriveAuditHealthStatus(
        verifier,
        outbox,
        anchorPublisher,
        (deps.anchorIntervalMs / 1000) * ANCHOR_STALL_INTERVAL_MULTIPLE,
      ),
      verifier,
      outbox,
      anchorPublisher,
    };
    return body;
  });
}
