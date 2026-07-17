-- Non-financial agent proposals (BRAIN-CORE-ORCHESTRATION-GAP.md §3). An
-- agent_proposal is a non-payment agent output: vendor risk, collections,
-- treasury, cash forecast, dispute, compliance, revenue intel, reconciliation,
-- subscription, and fraud anomaly findings that a human reviews and decides
-- on. This is a DISTINCT table from the financial `proposals` table
-- (migrations 0001/0013): `proposals` carries a proposing agent's PROPOSED
-- payment action through the §6 pre-execution gate toward money movement;
-- `agent_proposals` never touches a rail and never reaches an `executed`
-- state. It is reviewed, acknowledged, approved, or rejected, and an
-- approved-but-reversible one can be walked back to review.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_proposals (
  id                  TEXT        PRIMARY KEY,                  -- agpr_...
  tenant_id           TEXT        NOT NULL,
  type                TEXT        NOT NULL
                       CHECK (type IN ('vendor_risk', 'payment_batch', 'collections', 'treasury',
                                        'cash_forecast', 'dispute', 'compliance', 'revenue_intel',
                                        'reconciliation', 'subscription', 'fraud_anomaly')),
  agent_principal     TEXT        NOT NULL,
  risk_band           TEXT        NOT NULL
                       CHECK (risk_band IN ('low', 'standard', 'elevated', 'high')),
  execution_mode      TEXT        NOT NULL
                       CHECK (execution_mode IN ('propose', 'notify_only')),
  status              TEXT        NOT NULL DEFAULT 'needs_review'
                       CHECK (status IN ('needs_review', 'acknowledged', 'approved', 'rejected',
                                          'undone_to_review')),
  title               TEXT        NOT NULL,
  amount              TEXT,
  confidence          NUMERIC,
  narrative           TEXT        NOT NULL DEFAULT '',
  evidence            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  links               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  policy_decision_id  TEXT,
  reversible          BOOLEAN     NOT NULL DEFAULT false,
  decision            TEXT,
  decision_edit       JSONB,
  decided_by          TEXT,
  decided_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_proposals_tenant_status
  ON agent_proposals (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_proposals_tenant_type
  ON agent_proposals (tenant_id, type, created_at DESC);

ALTER TABLE agent_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_proposals
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON agent_proposals
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON agent_proposals
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- New tables force RLS at creation time (0023_members.sql precedent) rather
-- than waiting for a follow-up "force rls" migration like 0019 had to do for
-- tables created before that policy existed.
ALTER TABLE agent_proposals FORCE ROW LEVEL SECURITY;

COMMIT;
