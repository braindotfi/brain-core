-- Governance Phase 2: immutable audit-derived report snapshots.
--
-- The live report endpoint regenerates from audit_events. This table freezes
-- the exact reviewed payload plus generation filters so external auditor links
-- do not drift as newer audit data arrives.

BEGIN;

CREATE TABLE IF NOT EXISTS governance_report_snapshots (
  id           TEXT        PRIMARY KEY,
  tenant_id    TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end   TIMESTAMPTZ NOT NULL,
  agent_id     TEXT,
  created_by   TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  report       JSONB       NOT NULL,
  CHECK (period_end > period_start)
);

CREATE INDEX IF NOT EXISTS idx_governance_report_snapshots_tenant_created
  ON governance_report_snapshots (tenant_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_governance_report_snapshots_tenant_period
  ON governance_report_snapshots (tenant_id, period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_governance_report_snapshots_tenant_agent
  ON governance_report_snapshots (tenant_id, agent_id)
  WHERE agent_id IS NOT NULL;

ALTER TABLE governance_report_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_report_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY governance_report_snapshots_isolation ON governance_report_snapshots
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY governance_report_snapshots_write ON governance_report_snapshots
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE OR REPLACE FUNCTION reject_governance_report_snapshot_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'governance_report_snapshots are immutable';
END;
$$;

DROP TRIGGER IF EXISTS governance_report_snapshots_immutable
  ON governance_report_snapshots;

CREATE TRIGGER governance_report_snapshots_immutable
  BEFORE UPDATE ON governance_report_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION reject_governance_report_snapshot_mutation();

COMMENT ON TABLE governance_report_snapshots IS
  'Immutable, tenant-scoped GovernanceReport payloads captured for auditor review.';
COMMENT ON COLUMN governance_report_snapshots.report IS
  'Frozen GovernanceReport JSON generated at snapshot creation time.';

COMMIT;
