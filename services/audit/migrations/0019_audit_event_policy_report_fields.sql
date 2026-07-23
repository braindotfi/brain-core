-- Native policy report fields for forward governance coverage.

BEGIN;

ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS policy_check_id TEXT,
  ADD COLUMN IF NOT EXISTS outcome TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_policy_report_time
  ON audit_events (tenant_id, policy_decision_id, created_at DESC, id DESC)
  WHERE policy_decision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_outcome_time
  ON audit_events (tenant_id, outcome, created_at DESC, id DESC)
  WHERE outcome IS NOT NULL;

COMMENT ON COLUMN audit_events.policy_check_id IS
  'Native policy check or matched rule id captured for governance reports from this migration forward.';
COMMENT ON COLUMN audit_events.outcome IS
  'Native outcome captured for governance reports from this migration forward. Historical reports still join policy_decisions.';

COMMIT;
