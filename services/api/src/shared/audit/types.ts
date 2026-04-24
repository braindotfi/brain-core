/**
 * Brain audit event shape.
 *
 * Maps directly to the `audit_events` table defined in
 * Brain_MVP_Architecture.md §3 Layer 5.
 *
 *   id UUID,
 *   tenant_id UUID,
 *   layer TEXT,              -- raw | wiki | policy | execution
 *   actor TEXT,              -- agent ID | user ID | partner ID
 *   action TEXT,
 *   inputs JSONB,            -- hashes and evidence refs, not full content
 *   outputs JSONB,
 *   policy_version INT?,
 *   event_hash BYTEA,        -- deterministic canonical hash
 *   prev_event_hash BYTEA?,  -- hash chain per tenant
 *   created_at TIMESTAMPTZ
 *
 * `inputs` and `outputs` must not contain PII (§6.1). Hashes, IDs, and
 * evidence pointers only. Callers hash/redact before emitting.
 */

export type AuditLayer = "raw" | "wiki" | "policy" | "execution" | "audit";

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
}

export interface AuditEvent extends AuditEventInput {
  readonly id: string;
  readonly eventHash: string;
  readonly prevEventHash: string | null;
  readonly createdAt: string; // ISO-8601 UTC
}
