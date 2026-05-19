/**
 * Brain audit event shape.
 *
 * Maps directly to the `audit_events` table defined in
 * Brain_MVP_Architecture.md §3 Layer 6.
 *
 *   id TEXT,
 *   tenant_id TEXT,
 *   layer TEXT,              -- raw | ledger | wiki | policy | execution | agent | audit
 *   actor TEXT,              -- agent ID | user ID | partner ID
 *   action TEXT,
 *   inputs JSONB,            -- hashes and evidence refs, not full content
 *   outputs JSONB,
 *   policy_version INT?,
 *   policy_decision_id TEXT?, -- v0.3 §6 pre-execution gate pointer
 *   before_state JSONB?,      -- v0.3 — material state transitions
 *   after_state JSONB?,
 *   event_hash BYTEA,         -- deterministic canonical hash
 *   prev_event_hash BYTEA?,   -- per-tenant chain
 *   created_at TIMESTAMPTZ
 *
 * `inputs` and `outputs` must not contain PII (§7.1). Hashes, IDs, and
 * evidence pointers only. Callers hash/redact before emitting.
 */

export type AuditLayer = "raw" | "ledger" | "wiki" | "policy" | "execution" | "agent" | "audit";

export interface AuditEventInput {
  readonly tenantId: string;
  readonly layer: AuditLayer;
  /** Principal ID that caused the event (user, agent, partner). */
  readonly actor: string;
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
}

export interface AuditEvent extends AuditEventInput {
  readonly id: string;
  readonly eventHash: string;
  readonly prevEventHash: string | null;
  readonly createdAt: string; // ISO-8601 UTC
}
