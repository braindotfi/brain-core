/**
 * Brain audit event shape.
 *
 * Maps directly to the `audit_events` table defined in
 * Brain_MVP_Architecture.md §3 Layer 6.
 *
 *   id TEXT,
 *   tenant_id TEXT,
 *   layer TEXT,              -- raw | canonical | ledger | wiki | policy | execution | agent | audit | identity
 *   event_type TEXT,         -- system_activity | assistant_activity | flagged
 *   severity TEXT,           -- info | warning | critical
 *   actor TEXT,              -- agent ID | user ID | partner ID
 *   actor_display_name TEXT?,
 *   actor_email TEXT?,
 *   action TEXT,
 *   inputs JSONB,            -- hashes and evidence refs unless action contract allows text
 *   outputs JSONB,
 *   policy_version INT?,
 *   policy_decision_id TEXT?, -- v0.3 §6 pre-execution gate pointer
 *   before_state JSONB?,      -- v0.3 — material state transitions
 *   after_state JSONB?,
 *   key_id TEXT?,            -- API key id for request attribution
 *   event_hash BYTEA,         -- deterministic canonical hash
 *   prev_event_hash BYTEA?,   -- per-tenant chain
 *   created_at TIMESTAMPTZ
 *
 * `inputs` and `outputs` must not contain PII (§7.1) unless the action's
 * audit contract explicitly allows client-display text, such as wiki.question.
 * Callers hash or redact before emitting.
 */

export type AuditLayer =
  | "raw"
  | "canonical"
  | "ledger"
  | "wiki"
  | "policy"
  | "execution"
  | "agent"
  | "audit"
  | "identity";

export type AuditEventType = "system_activity" | "assistant_activity" | "flagged";

export type AuditSeverity = "info" | "warning" | "critical";

export interface AuditActorDisplay {
  readonly displayName?: string;
  readonly email?: string;
}

export interface AuditEventInput {
  readonly tenantId: string;
  readonly layer: AuditLayer;
  /** Client-facing audit classification. `flagged` is reserved for risk events. */
  readonly eventType?: AuditEventType;
  /** Severity implied by eventType unless explicitly set. */
  readonly severity?: AuditSeverity;
  /** Principal ID that caused the event (user, agent, partner). */
  readonly actor: string;
  /** Optional human display fields when the emitting service already knows them. */
  readonly actorDisplayName?: string;
  readonly actorEmail?: string;
  /** Short verb describing the action, e.g. "raw.ingest" or "policy.sign". */
  readonly action: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly outputs: Readonly<Record<string, unknown>>;
  /** Policy version active at event time. Null for events that are not
   *  policy-gated (e.g., raw ingestion). */
  readonly policyVersion?: number;
  /** PolicyDecision id for §6-gated events. */
  readonly policyDecisionId?: string;
  /** Pre-image of the entity for material state transitions. */
  readonly beforeState?: Readonly<Record<string, unknown>>;
  /** Post-image of the entity for material state transitions. */
  readonly afterState?: Readonly<Record<string, unknown>>;
  /**
   * Optional external idempotency key (unique per tenant). When set, the emitter
   * returns the EXISTING event if one was already written with this key instead
   * of inserting a duplicate — so an at-least-once publisher (e.g. the audit
   * outbox, keyed by its event_key) becomes effectively exactly-once. Omit for
   * ordinary emits (the common case); they are unconstrained.
   */
  readonly idempotencyKey?: string;
  /** Request correlation id from `X-Request-Id` or the server-generated request id. */
  readonly correlationId?: string;
  /** API key id that authenticated the request, when present. */
  readonly keyId?: string;
}

export interface AuditEvent extends AuditEventInput {
  readonly id: string;
  readonly eventHash: string;
  readonly prevEventHash: string | null;
  readonly createdAt: string; // ISO-8601 UTC
}

export interface NormalizedAuditEventInput extends AuditEventInput {
  readonly eventType: AuditEventType;
  readonly severity: AuditSeverity;
}

export function normalizeAuditEventType(eventType: AuditEventType | undefined): AuditEventType {
  return eventType ?? "system_activity";
}

export function normalizeAuditSeverity(
  eventType: AuditEventType | undefined,
  severity: AuditSeverity | undefined,
): AuditSeverity {
  if (severity !== undefined) return severity;
  return normalizeAuditEventType(eventType) === "flagged" ? "warning" : "info";
}

export function normalizeAuditEventInput(event: AuditEventInput): NormalizedAuditEventInput {
  const eventType = normalizeAuditEventType(event.eventType);
  const severity = normalizeAuditSeverity(eventType, event.severity);
  return { ...event, eventType, severity };
}
