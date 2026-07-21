-- Nullable API-key attribution for request-path audit events.

BEGIN;

ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS key_id TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_key_time
  ON audit_events (tenant_id, key_id, created_at DESC, id DESC)
  WHERE key_id IS NOT NULL;

COMMENT ON COLUMN audit_events.key_id IS
  'API key id that authenticated the request, when present. Session-authenticated and pre-enforcement events keep this null.';

COMMIT;
