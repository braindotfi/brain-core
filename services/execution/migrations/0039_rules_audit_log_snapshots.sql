BEGIN;

CREATE TABLE IF NOT EXISTS agent_authority_rules (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent TEXT NOT NULL CHECK (agent IN (
    'fraud_anomaly',
    'vendor_risk',
    'dispute',
    'aml_compliance',
    'payment',
    'collections',
    'treasury',
    'subscription_management',
    'invoice_integrity',
    'reconciliation',
    'cash_forecast',
    'revenue_intel'
  )),
  decision TEXT NOT NULL,
  condition JSONB NOT NULL DEFAULT '{}'::jsonb,
  authority TEXT NOT NULL CHECK (authority IN ('auto', 'propose', 'deny')),
  priority INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_authority_rules_tenant_agent
  ON agent_authority_rules (tenant_id, agent, enabled, priority DESC, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS proposal_payload_snapshots (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  payload_sha256 TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_proposal_payload_snapshots_tenant_created
  ON proposal_payload_snapshots (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_audit_log (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  actor JSONB NOT NULL,
  proposal_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  decision TEXT NOT NULL,
  outcome JSONB NOT NULL,
  policy_context JSONB NOT NULL,
  payload_snapshot_id UUID NOT NULL REFERENCES proposal_payload_snapshots(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL,
  event_action TEXT NOT NULL,
  archived_at TIMESTAMPTZ,
  cold_storage_uri TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_decision_audit_log_tenant_occurred
  ON decision_audit_log (tenant_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_decision_audit_log_tenant_actor
  ON decision_audit_log (tenant_id, ((actor->>'type')), occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_audit_log_tenant_agent
  ON decision_audit_log (tenant_id, agent, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_audit_log_tenant_decision
  ON decision_audit_log (tenant_id, decision, occurred_at DESC);

CREATE TABLE IF NOT EXISTS decision_audit_log_archive_runs (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  cutoff TIMESTAMPTZ NOT NULL,
  archived_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE agent_authority_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_authority_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_authority_rules_tenant_read ON agent_authority_rules
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY agent_authority_rules_tenant_insert ON agent_authority_rules
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY agent_authority_rules_tenant_update ON agent_authority_rules
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE proposal_payload_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal_payload_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY proposal_payload_snapshots_tenant_read ON proposal_payload_snapshots
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY proposal_payload_snapshots_tenant_insert ON proposal_payload_snapshots
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE decision_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY decision_audit_log_tenant_read ON decision_audit_log
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY decision_audit_log_tenant_insert ON decision_audit_log
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY decision_audit_log_tenant_update ON decision_audit_log
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE decision_audit_log_archive_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_audit_log_archive_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY decision_audit_log_archive_runs_tenant_read ON decision_audit_log_archive_runs
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY decision_audit_log_archive_runs_tenant_insert ON decision_audit_log_archive_runs
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
