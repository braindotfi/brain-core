/**
 * Classify a per-object delete error from a blob purge (GDPR Art. 17 erasure).
 *
 * The S3 and Azure adapters delete every object version under a tenant prefix.
 * A per-object delete can fail for very different reasons, and the worker must
 * treat them differently (review 2026-06-07 P1 #2):
 *
 *   - legal_hold  → TERMINAL. A WORM / object-lock / immutability policy. A hold
 *                   will not clear on its own; surface it for the release runbook.
 *   - transient   → RETRY. Throttling, timeout, 5xx, network blip.
 *   - authorization → RETRY (bounded). 401/403 that is NOT an object lock. Burns
 *                   attempts → dead-letter (operator action), never a legal hold.
 *   - unknown     → RETRY (bounded), conservatively. Never labelled a legal hold.
 *
 * Pure + provider-agnostic: reads the error shape of both the AWS SDK v3
 * (`name`, `$metadata.httpStatusCode`) and the Azure SDK (`code`, `statusCode`).
 */

import type { BlobPurgeFailureCategory } from "./types.js";

export interface ClassifiedBlobDeleteError {
  category: BlobPurgeFailureCategory;
  retryable: boolean;
  providerCode?: string;
}

const TRANSIENT_CODES = new Set([
  "RequestTimeout",
  "RequestTimeTooSkewed",
  "SlowDown",
  "ThrottlingException",
  "ThrottledException",
  "TooManyRequestsException",
  "ServiceUnavailable",
  "InternalError",
  "InternalServerError",
  "PriorRequestNotComplete",
  "ServerBusy",
  "OperationTimedOut",
  "TimeoutError",
  "RequestThrottled",
]);

// Node socket/DNS errnos that surface on a transient network failure.
const TRANSIENT_ERRNOS = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "ENOTFOUND",
  "ECONNABORTED",
]);

const AUTH_CODES = new Set([
  "AccessDenied",
  "AuthenticationFailed",
  "AuthorizationFailure",
  "AuthorizationPermissionMismatch",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "ExpiredToken",
  "InvalidToken",
  "CredentialsNotFound",
  "Forbidden",
]);

// Provider codes that unambiguously mean an immutability / WORM policy.
const LEGAL_HOLD_CODES = new Set(["BlobImmutableDueToPolicy", "BlobImmutabilityPolicyDeleteError"]);

// Message signals for an object-lock / legal hold (S3 surfaces these as 403
// AccessDenied with the reason only in the message, so a text probe is needed).
const LEGAL_HOLD_RE = /object[- ]?lock|legal[- ]?hold|\bworm\b|immutab|retention/i;

function errorBits(err: unknown): {
  code: string | undefined;
  status: number | undefined;
  message: string;
} {
  if (typeof err !== "object" || err === null) {
    return { code: undefined, status: undefined, message: String(err) };
  }
  const e = err as Record<string, unknown>;
  const name = typeof e["name"] === "string" && e["name"] !== "Error" ? e["name"] : undefined;
  const code =
    name ??
    (typeof e["code"] === "string" ? e["code"] : undefined) ??
    (typeof e["Code"] === "string" ? e["Code"] : undefined);
  const meta = e["$metadata"];
  const metaStatus =
    typeof meta === "object" && meta !== null
      ? (meta as Record<string, unknown>)["httpStatusCode"]
      : undefined;
  const resp = e["$response"];
  const respStatus =
    typeof resp === "object" && resp !== null
      ? (resp as Record<string, unknown>)["status"]
      : undefined;
  const status =
    (typeof metaStatus === "number" ? metaStatus : undefined) ??
    (typeof e["statusCode"] === "number" ? e["statusCode"] : undefined) ??
    (typeof respStatus === "number" ? respStatus : undefined);
  const message = typeof e["message"] === "string" ? e["message"] : String(err);
  return { code, status, message };
}

export function classifyBlobDeleteError(err: unknown): ClassifiedBlobDeleteError {
  const { code, status, message } = errorBits(err);
  const out = (
    category: BlobPurgeFailureCategory,
    retryable: boolean,
  ): ClassifiedBlobDeleteError =>
    code !== undefined ? { category, retryable, providerCode: code } : { category, retryable };

  // 1. Legal hold / immutability is TERMINAL — and checked FIRST, because an
  //    object-lock denial can arrive as a 403 AccessDenied; the lock signal must
  //    win over the authorization bucket so a real hold is never retried forever.
  if ((code !== undefined && LEGAL_HOLD_CODES.has(code)) || LEGAL_HOLD_RE.test(message)) {
    return out("legal_hold", false);
  }
  // 2. Transient: throttling / timeout / 5xx / 429 / network.
  if (
    (status !== undefined && (status >= 500 || status === 429)) ||
    (code !== undefined && (TRANSIENT_CODES.has(code) || TRANSIENT_ERRNOS.has(code)))
  ) {
    return out("transient", true);
  }
  // 3. Authorization (401/403, not an object lock) — retried, bounded.
  if (
    (status !== undefined && (status === 401 || status === 403)) ||
    (code !== undefined && AUTH_CODES.has(code))
  ) {
    return out("authorization", true);
  }
  // 4. Anything else: unknown, retried conservatively (never a legal hold).
  return out("unknown", true);
}
