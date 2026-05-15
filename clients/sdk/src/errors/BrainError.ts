/**
 * `BrainError` — the base class for every error the SDK throws.
 *
 * The class carries the canonical fields from the wire envelope at
 * https://docs.brain.fi/api-reference/overview:
 *
 *     { error: { code, message, details?, trace_id, docs_url } }
 *
 * Subclasses below pin `code` to a specific string literal so callers
 * can use `instanceof PolicyDeniedError` for branch logic.
 *
 * @packageDocumentation
 */

import type { BrainErrorCode } from "./codes.js";

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

export interface BrainErrorOptions {
  /** Optional structured payload from the server (per docs). */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Server-issued correlation id (`trace_id` in the wire envelope). */
  readonly traceId?: string;
  /**
   * Direct link to the docs page for this error code (the `docs_url`
   * field on the wire). Defaults to
   * `https://docs.brain.fi/errors/{code}` when omitted.
   */
  readonly docsUrl?: string;
  /** HTTP status the server returned. */
  readonly statusCode?: number;
  /** Optional cause for error chains. */
  readonly cause?: unknown;
}

const DEFAULT_DOCS_BASE = "https://docs.brain.fi/errors/";

export class BrainError extends Error {
  public readonly code: BrainErrorCode;
  public readonly details: Readonly<Record<string, unknown>> | undefined;
  public readonly traceId: string | undefined;
  public readonly docsUrl: string;
  public readonly statusCode: number | undefined;

  public constructor(
    code: BrainErrorCode,
    message: string,
    opts: BrainErrorOptions = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "BrainError";
    this.code = code;
    this.details = opts.details;
    this.traceId = opts.traceId;
    this.docsUrl = opts.docsUrl ?? `${DEFAULT_DOCS_BASE}${code}`;
    this.statusCode = opts.statusCode;
    // Preserve prototype chain after transpilation (necessary for
    // `instanceof` checks to work in tsc/esbuild output).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Duck-typed `instanceof BrainError` that survives multiple module copies. */
export function isBrainError(err: unknown): err is BrainError {
  if (err instanceof BrainError) return true;
  return (
    err !== null &&
    typeof err === "object" &&
    (err as Record<string, unknown>)["name"] === "BrainError" &&
    typeof (err as Record<string, unknown>)["code"] === "string"
  );
}

// ---------------------------------------------------------------------------
// Subclass factory — one class per v0.3 docs code.
//
// We don't subclass for every v0.1/v0.2 legacy code; those surface as the
// base `BrainError` with their `code` set, so `err.code === "auth_token_invalid"`
// still works. The named subclasses below are the ones the docs actively
// document and that consumers are most likely to want for branch logic.
// ---------------------------------------------------------------------------

/**
 * Helper that returns a class whose `code` is pinned to the supplied
 * literal. Each call produces a distinct constructor, so `instanceof`
 * works as expected on the returned class.
 */
function brainErrorClass<C extends BrainErrorCode>(code: C) {
  class TypedBrainError extends BrainError {
    public override readonly code: C;
    public constructor(message: string, opts: BrainErrorOptions = {}) {
      super(code, message, opts);
      this.code = code;
    }
  }
  return TypedBrainError;
}

// Auth
export class AuthInvalidKeyError extends brainErrorClass("auth_invalid_key") {}
export class AuthExpiredError extends brainErrorClass("auth_expired") {}
export class AuthSiwxInvalidError extends brainErrorClass(
  "auth_siwx_invalid",
) {}
export class ScopeInsufficientError extends brainErrorClass(
  "scope_insufficient",
) {}

// Tenant
export class TenantNotFoundError extends brainErrorClass("tenant_not_found") {}
export class TenantSuspendedError extends brainErrorClass(
  "tenant_suspended",
) {}
export class TenantAccessDeniedError extends brainErrorClass(
  "tenant_access_denied",
) {}

// Source
export class SourceNotFoundError extends brainErrorClass("source_not_found") {}
export class SourceRateLimitError extends brainErrorClass(
  "source_rate_limit",
) {}
export class SourceCredentialInvalidError extends brainErrorClass(
  "source_credential_invalid",
) {}

// Policy
export class PolicyNotActiveError extends brainErrorClass(
  "policy_not_active",
) {}
export class PolicyDeniedError extends brainErrorClass("policy_denied") {}
export class PolicyEscalateError extends brainErrorClass("policy_escalate") {}

// Agent
export class AgentNotFoundError extends brainErrorClass("agent_not_found") {}
export class AgentInactiveError extends brainErrorClass("agent_inactive") {}
export class ScopeHashMismatchError extends brainErrorClass(
  "scope_hash_mismatch",
) {}
export class ScopeExpiredError extends brainErrorClass("scope_expired") {}

// Action
export class ActionNotFoundError extends brainErrorClass("action_not_found") {}
export class ActionAlreadyExecutedError extends brainErrorClass(
  "action_already_executed",
) {}
export class InsufficientBalanceError extends brainErrorClass(
  "insufficient_balance",
) {}
export class LimitsExceededError extends brainErrorClass("limits_exceeded") {}
export class IdempotencyKeyReusedError extends brainErrorClass(
  "idempotency_key_reused",
) {}

// Pre-execution gate (8 codes)
export class GateNoPolicyDecisionError extends brainErrorClass(
  "gate_no_policy_decision",
) {}
export class GatePolicyVersionStaleError extends brainErrorClass(
  "gate_policy_version_stale",
) {}
export class GateCounterpartyUnverifiedError extends brainErrorClass(
  "gate_counterparty_unverified",
) {}
export class GateCounterpartySanctionedError extends brainErrorClass(
  "gate_counterparty_sanctioned",
) {}
export class GateBalanceInsufficientError extends brainErrorClass(
  "gate_balance_insufficient",
) {}
export class GateApprovalIncompleteError extends brainErrorClass(
  "gate_approval_incomplete",
) {}
export class GateSessionKeyInvalidError extends brainErrorClass(
  "gate_session_key_invalid",
) {}
export class GateAuditChainStaleError extends brainErrorClass(
  "gate_audit_chain_stale",
) {}

// Validation
export class ValidationFailedError extends brainErrorClass(
  "validation_failed",
) {}
export class MissingRequiredFieldError extends brainErrorClass(
  "missing_required_field",
) {}
export class InvalidCursorError extends brainErrorClass("invalid_cursor") {}

// Infrastructure
export class RateLimitedError extends brainErrorClass("rate_limited") {}
export class InternalError extends brainErrorClass("internal_error") {}
export class UpstreamTimeoutError extends brainErrorClass(
  "upstream_timeout",
) {}
export class MaintenanceModeError extends brainErrorClass(
  "maintenance_mode",
) {}

// ---------------------------------------------------------------------------
// code → constructor lookup
// ---------------------------------------------------------------------------

/**
 * Map from wire code to the concrete subclass constructor. The HTTP
 * transport uses this to materialize the right subclass when parsing
 * the server's error envelope.
 *
 * Codes not listed here (the v0.1/v0.2 legacy set) fall through to the
 * base `BrainError` constructor.
 *
 * @internal
 */
export const BRAIN_ERROR_CLASS_BY_CODE = {
  auth_invalid_key: AuthInvalidKeyError,
  auth_expired: AuthExpiredError,
  auth_siwx_invalid: AuthSiwxInvalidError,
  scope_insufficient: ScopeInsufficientError,
  tenant_not_found: TenantNotFoundError,
  tenant_suspended: TenantSuspendedError,
  tenant_access_denied: TenantAccessDeniedError,
  source_not_found: SourceNotFoundError,
  source_rate_limit: SourceRateLimitError,
  source_credential_invalid: SourceCredentialInvalidError,
  policy_not_active: PolicyNotActiveError,
  policy_denied: PolicyDeniedError,
  policy_escalate: PolicyEscalateError,
  agent_not_found: AgentNotFoundError,
  agent_inactive: AgentInactiveError,
  scope_hash_mismatch: ScopeHashMismatchError,
  scope_expired: ScopeExpiredError,
  action_not_found: ActionNotFoundError,
  action_already_executed: ActionAlreadyExecutedError,
  insufficient_balance: InsufficientBalanceError,
  limits_exceeded: LimitsExceededError,
  idempotency_key_reused: IdempotencyKeyReusedError,
  gate_no_policy_decision: GateNoPolicyDecisionError,
  gate_policy_version_stale: GatePolicyVersionStaleError,
  gate_counterparty_unverified: GateCounterpartyUnverifiedError,
  gate_counterparty_sanctioned: GateCounterpartySanctionedError,
  gate_balance_insufficient: GateBalanceInsufficientError,
  gate_approval_incomplete: GateApprovalIncompleteError,
  gate_session_key_invalid: GateSessionKeyInvalidError,
  gate_audit_chain_stale: GateAuditChainStaleError,
  validation_failed: ValidationFailedError,
  missing_required_field: MissingRequiredFieldError,
  invalid_cursor: InvalidCursorError,
  rate_limited: RateLimitedError,
  internal_error: InternalError,
  upstream_timeout: UpstreamTimeoutError,
  maintenance_mode: MaintenanceModeError,
} as const;
