BEGIN;

ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS correlation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_correlation
  ON audit_events (tenant_id, correlation_id, created_at DESC, id DESC)
  WHERE correlation_id IS NOT NULL;

COMMENT ON COLUMN audit_events.correlation_id IS
  'Request correlation id from X-Request-Id or the generated request id. Propagated to outbound webhook payloads.';

COMMIT;
