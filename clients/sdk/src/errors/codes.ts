/**
 * The canonical error code registry, mirrored from
 * https://docs.brain.fi/resources/errors.
 *
 * This list is the SDK's local copy — it intentionally does **not** import
 * from `services/api/src/shared/errors.ts` because @brain/sdk is published
 * to npm and must not depend on an internal workspace. The two registries
 * stay in sync via the audit at `docs/sdk-audit.md`.
 *
 * Wire codes are lowercase snake_case (per Standards §4.3). The docs site
 * publishes the same identifiers in SCREAMING_SNAKE_CASE as a presentation
 * choice — the wire bytes are always lowercase.
 *
 * @packageDocumentation
 */

export const BRAIN_ERROR_CODES = [
  // -------------------------------------------------------------------------
  // v0.3 — canonical docs codes (https://docs.brain.fi/resources/errors)
  // -------------------------------------------------------------------------

  // Auth
  "auth_invalid_key",
  "auth_expired",
  "auth_siwx_invalid",
  "scope_insufficient",

  // Tenant
  "tenant_not_found",
  "tenant_suspended",
  "tenant_access_denied",

  // Source
  "source_not_found",
  "source_rate_limit",
  "source_credential_invalid",

  // Policy
  "policy_not_active",
  "policy_denied",
  "policy_escalate",

  // Agent
  "agent_not_found",
  "agent_inactive",
  "scope_hash_mismatch",
  "scope_expired",

  // Action (v0.3 unified name for the Proposal + PaymentIntent surface)
  "action_not_found",
  "action_already_executed",
  "insufficient_balance",
  "limits_exceeded",
  "idempotency_key_reused",

  // Pre-execution gate (8 codes; one per failing check)
  "gate_no_policy_decision",
  "gate_policy_version_stale",
  "gate_counterparty_unverified",
  "gate_counterparty_sanctioned",
  "gate_balance_insufficient",
  "gate_approval_incomplete",
  "gate_session_key_invalid",
  "gate_audit_chain_stale",

  // Validation
  "validation_failed",
  "missing_required_field",
  "invalid_cursor",

  // Infrastructure
  "rate_limited",
  "internal_error",
  "upstream_timeout",
  "maintenance_mode",

  // -------------------------------------------------------------------------
  // v0.1 / v0.2 — still shipped per Standards §4.3 "additions only".
  // The server may emit any of these from legacy code paths. The SDK
  // recognizes them so consumers can pattern-match without breakage.
  // -------------------------------------------------------------------------

  "auth_token_missing",
  "auth_token_invalid",
  "auth_token_expired",
  "auth_scope_insufficient",
  "auth_tenant_mismatch",
  "request_body_invalid",
  "request_params_invalid",
  "request_too_large",
  "raw_artifact_not_found",
  "raw_artifact_tombstoned",
  "raw_source_unsupported",
  "raw_webhook_signature_invalid",
  "wiki_entity_not_found",
  "wiki_page_not_found",
  "wiki_schema_validation_failed",
  "wiki_temporal_range_invalid",
  "wiki_question_timeout",
  "policy_not_found",
  "policy_rule_invalid",
  "policy_quorum_not_met",
  "policy_signature_invalid",
  "policy_version_mismatch",
  "execution_proposal_not_found",
  "execution_proposal_invalid_state",
  "execution_rail_unavailable",
  "execution_idempotency_conflict",
  "execution_agent_not_registered",
  "audit_event_not_found",
  "audit_proof_invalid",
  "audit_anchor_not_yet_published",
  "dependency_unavailable",
  "internal_server_error",
  "rate_limit_exceeded",
] as const;

/** Union of every registered error code. */
export type BrainErrorCode = (typeof BRAIN_ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set(BRAIN_ERROR_CODES);

/** Runtime guard for `BrainErrorCode`. */
export function isBrainErrorCode(code: string): code is BrainErrorCode {
  return ERROR_CODE_SET.has(code);
}
