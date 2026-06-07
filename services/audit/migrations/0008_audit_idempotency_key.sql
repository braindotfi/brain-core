-- 2026-06-07 audit-subsystem review P2: make audit delivery end-to-end
-- idempotent.
--
-- An outbox publisher that emits an audit event, then crashes before marking the
-- outbox row published, retries and emits a SECOND audit event — at-least-once,
-- not exactly-once. The outbox event_key dedupes the outbox INSERT but not the
-- audit_events INSERT.
--
-- Add a nullable external idempotency key + a per-tenant partial unique index.
-- The emitter inserts with this key (when supplied) so a replay returns the
-- existing event instead of writing a duplicate. NULL keys (every pre-existing
-- and non-outbox emit) are unconstrained, so this is fully backward compatible.

ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_events_tenant_idempotency
  ON audit_events (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
