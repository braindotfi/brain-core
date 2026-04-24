-- Brain proposals table.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 4 + Brain_Engineering_Standards.md §8.1.

BEGIN;

CREATE TABLE IF NOT EXISTS proposals (
  id                  TEXT        PRIMARY KEY,            -- prop_...
  tenant_id           TEXT        NOT NULL,
  proposing_agent     TEXT        NOT NULL,               -- agent_id
  action              JSONB       NOT NULL,
  policy_version      INTEGER     NOT NULL,
  policy_decision     TEXT        NOT NULL
                       CHECK (policy_decision IN ('allow','confirm','reject')),
  policy_trace        JSONB       NOT NULL,
  required_approvers  TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  status              TEXT        NOT NULL
                       CHECK (status IN ('pending','approved','rejected','executed','failed')),
  approvers_signed    TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proposals_tenant_status
  ON proposals (tenant_id, status, created_at DESC);

ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON proposals
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON proposals
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON proposals
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
