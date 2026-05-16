/**
 * Brain error registry and error envelope.
 *
 * Sources of truth:
 *   - Brain_Engineering_Standards.md §4 (envelope shape, status mapping, code registry)
 *   - Brain_Engineering_Standards.md §4.1 canonical body:
 *       { error: { code, message, details?, request_id, docs_url } }
 *
 * Note: the OpenAPI `Error` schema is a flatter legacy shape; per §13 of the
 * standards, error handling is governed by the standards doc, not the spec.
 * A follow-up PR should update Brain_API_Specification.yaml to match §4.1.
 *
 * Error codes are stable machine-readable strings. Once shipped, a code is
 * forever. Adding a new code requires touching this file AND the OpenAPI spec
 * in the same PR (§4.3).
 */

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * The canonical error code registry from §4.3.
 *
 * Codes follow `{domain}_{condition}` snake_case. Never rename. Additions only.
 */
export const BRAIN_ERROR_CODES = [
  // Auth
  "auth_token_missing",
  "auth_token_invalid",
  "auth_token_expired",
  "auth_scope_insufficient",
  "auth_tenant_mismatch",

  // Validation
  "request_body_invalid",
  "request_params_invalid",
  "request_too_large",

  // Raw
  "raw_artifact_not_found",
  "raw_artifact_tombstoned",
  "raw_source_unsupported",
  "raw_webhook_signature_invalid",

  // Ledger
  "ledger_row_not_found",
  "ledger_row_invalid",

  // Wiki
  "wiki_entity_not_found",
  "wiki_page_not_found",
  "wiki_schema_validation_failed",
  "wiki_temporal_range_invalid",
  "wiki_question_timeout",

  // Policy
  "policy_not_found",
  "policy_rule_invalid",
  "policy_quorum_not_met",
  "policy_signature_invalid",
  "policy_version_mismatch",

  // MCP / Agent registry
  "agent_not_registered",
  "agent_scope_hash_mismatch",

  // Execution
  "execution_proposal_not_found",
  "execution_proposal_invalid_state",
  "execution_rail_unavailable",
  "execution_idempotency_conflict",
  "execution_agent_not_registered",
  "payment_intent_not_found",
  "payment_intent_invalid_state",
  "payment_intent_gate_failed",
  "agent_rail_unavailable",

  // Audit
  "audit_event_not_found",
  "audit_proof_invalid",
  "audit_anchor_not_yet_published",

  // Infrastructure
  "dependency_unavailable",
  "internal_server_error",
  "rate_limit_exceeded",
] as const;

export type BrainErrorCode = (typeof BRAIN_ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set(BRAIN_ERROR_CODES);

export function isBrainErrorCode(code: string): code is BrainErrorCode {
  return ERROR_CODE_SET.has(code);
}

// ---------------------------------------------------------------------------
// HTTP status mapping (§4.2 + table at end of standards)
// ---------------------------------------------------------------------------

/**
 * Default HTTP status for each error code.
 *
 * §4.2: never return 200 with an error in the body. Status and envelope must
 * agree. Callers may override per-throw if a more specific status applies.
 */
const HTTP_STATUS_BY_CODE: Readonly<Record<BrainErrorCode, number>> = {
  // 401 — authentication
  auth_token_missing: 401,
  auth_token_invalid: 401,
  auth_token_expired: 401,

  // 403 — authorization
  auth_scope_insufficient: 403,
  auth_tenant_mismatch: 403,

  // 400 — validation
  request_body_invalid: 400,
  request_params_invalid: 400,

  // 413 — too large
  request_too_large: 413,

  // 401 — MCP / on-chain agent
  agent_not_registered: 401,
  agent_scope_hash_mismatch: 401,

  // 404 — not found / tombstoned
  raw_artifact_not_found: 404,
  raw_artifact_tombstoned: 404,
  ledger_row_not_found: 404,
  wiki_entity_not_found: 404,
  wiki_page_not_found: 404,
  policy_not_found: 404,
  execution_proposal_not_found: 404,
  payment_intent_not_found: 404,
  audit_event_not_found: 404,

  // 400 — domain validation
  raw_source_unsupported: 400,
  ledger_row_invalid: 400,
  wiki_schema_validation_failed: 400,
  wiki_temporal_range_invalid: 400,
  policy_rule_invalid: 400,
  audit_proof_invalid: 400,

  // 401 — bad signature is auth-class
  raw_webhook_signature_invalid: 401,
  policy_signature_invalid: 401,

  // 408 — timeout on LLM reasoner
  wiki_question_timeout: 408,

  // 409 — conflict / illegal state
  policy_quorum_not_met: 409,
  policy_version_mismatch: 409,
  execution_proposal_invalid_state: 409,
  execution_idempotency_conflict: 409,
  execution_agent_not_registered: 409,
  payment_intent_invalid_state: 409,
  payment_intent_gate_failed: 409,
  audit_anchor_not_yet_published: 409,

  // 503 — dependency / rail outage
  execution_rail_unavailable: 503,
  agent_rail_unavailable: 503,
  dependency_unavailable: 503,

  // 429 — rate limit
  rate_limit_exceeded: 429,

  // 500 — last resort
  internal_server_error: 500,
};

export function httpStatusForCode(code: BrainErrorCode): number {
  return HTTP_STATUS_BY_CODE[code];
}

// ---------------------------------------------------------------------------
// Envelope type
// ---------------------------------------------------------------------------

export interface ErrorEnvelope {
  readonly error: {
    readonly code: BrainErrorCode;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly request_id: string;
    readonly docs_url: string;
  };
}

/**
 * Compose the §4.1 envelope body. `request_id` is required — the HTTP layer
 * injects it at serialization time; callers of `BrainError` do not set it.
 */
export function toErrorEnvelope(err: BrainError, requestId: string): ErrorEnvelope {
  const envelope: ErrorEnvelope["error"] = {
    code: err.code,
    message: err.message,
    request_id: requestId,
    docs_url: docsUrlFor(err.code),
    ...(err.details !== undefined ? { details: err.details } : {}),
  };
  return { error: envelope };
}

export function docsUrlFor(code: BrainErrorCode): string {
  return `https://docs.brain.fi/errors/${code}`;
}

// ---------------------------------------------------------------------------
// BrainError class
// ---------------------------------------------------------------------------

export interface BrainErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly statusOverride?: number;
  readonly cause?: unknown;
}

/**
 * The only error type the HTTP layer understands natively. Anywhere else, wrap
 * or map into one of these before the response is serialized.
 */
export class BrainError extends Error {
  public readonly code: BrainErrorCode;
  public readonly statusCode: number;
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  public constructor(code: BrainErrorCode, message: string, opts: BrainErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "BrainError";
    this.code = code;
    this.statusCode = opts.statusOverride ?? httpStatusForCode(code);
    this.details = opts.details;
    // Preserve prototype chain across transpilation.
    Object.setPrototypeOf(this, BrainError.prototype);
  }
}

/**
 * Convenience factory preserved for readability at call sites.
 *
 *     throw brainError("auth_token_expired", "JWT exp passed")
 */
export function brainError(
  code: BrainErrorCode,
  message: string,
  opts: BrainErrorOptions = {},
): BrainError {
  return new BrainError(code, message, opts);
}

export function isBrainError(err: unknown): err is BrainError {
  // Duck-type check: robust against instanceof failing across ESM module instances
  // (e.g. tsx-compiled source vs pre-compiled dist in single-process multi-service boot).
  if (err instanceof BrainError) return true;
  return (
    err !== null &&
    typeof err === "object" &&
    (err as Record<string, unknown>)["name"] === "BrainError" &&
    typeof (err as Record<string, unknown>)["code"] === "string" &&
    typeof (err as Record<string, unknown>)["statusCode"] === "number"
  );
}
