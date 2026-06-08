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
import { reportVerifierHealth, type AuditVerifierHealth } from "@brain/audit";
import {
  reportAuditOutboxHealth,
  type AuditOutboxHealth,
} from "../tenant-deletion/blob-purge-audit-outbox.js";

const ADMIN: Scope = "audit:admin";

export interface AuditHealthRouteDeps {
  /** MUST be the BYPASSRLS privileged pool: the queries span every tenant. */
  privilegedPool: Pool;
}

export type AuditHealthStatus = "safe" | "degraded" | "critical";

export interface AuditHealthResponse {
  status: AuditHealthStatus;
  verifier: AuditVerifierHealth;
  outbox: AuditOutboxHealth;
}

/**
 * Roll the two snapshots into one operator-facing status:
 *   critical — an active integrity break or undelivered mandatory evidence:
 *              a failed last pass, any open finding, or any exhausted outbox row.
 *   degraded — no clean pass yet, or events this build cannot content-verify.
 *   safe     — last pass clean, no open findings, no exhausted evidence.
 */
export function deriveAuditHealthStatus(
  verifier: AuditVerifierHealth,
  outbox: AuditOutboxHealth,
): AuditHealthStatus {
  if (verifier.lastPassStatus === "failed" || verifier.openFindings > 0 || outbox.exhausted > 0) {
    return "critical";
  }
  if (
    verifier.lastPassStatus === "never" ||
    verifier.unsupportedVersion > 0 ||
    verifier.legacyUnverifiable > 0
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

    const [verifier, outbox] = await Promise.all([
      reportVerifierHealth({ privilegedPool: deps.privilegedPool }),
      reportAuditOutboxHealth({ privilegedPool: deps.privilegedPool }),
    ]);

    reply.status(200);
    const body: AuditHealthResponse = {
      status: deriveAuditHealthStatus(verifier, outbox),
      verifier,
      outbox,
    };
    return body;
  });
}
