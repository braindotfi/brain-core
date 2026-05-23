-- High-risk agent findings + overrides (Agent Autonomy v3, 2.6).
-- A finding is an auditable artifact separate from the proposal: Vendor Risk and
-- Compliance emit one before any block/confirm flow. A block can be overridden by
-- a tenant-root operator via an override row that records the stated reason and
-- references the original finding; subsequent runs read the override history.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_findings (
  id            TEXT        PRIMARY KEY,                   -- agfn_...
  tenant_id     TEXT        NOT NULL,
  agent_id      TEXT        NOT NULL,
  finding_kind  TEXT        NOT NULL,
  severity      TEXT        NOT NULL
                 CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  rule_id       TEXT,                                      -- from the agent's finding-rule catalog
  rule_catalog_version TEXT,
  subject_type  TEXT,
  subject_id    TEXT,
  detail        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT        NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'overridden', 'resolved')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_findings_tenant_agent
  ON agent_findings (tenant_id, agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_finding_overrides (
  id             TEXT        PRIMARY KEY,                  -- agfo_...
  tenant_id      TEXT        NOT NULL,
  finding_id     TEXT        NOT NULL REFERENCES agent_findings(id),
  agent_id       TEXT        NOT NULL,
  overridden_by  TEXT        NOT NULL,                     -- the human principal id
  reason         TEXT        NOT NULL,                     -- stated reason (mandatory)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_finding_overrides_agent
  ON agent_finding_overrides (tenant_id, agent_id, created_at DESC);

ALTER TABLE agent_findings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_findings
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON agent_findings
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON agent_findings
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE agent_finding_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_finding_overrides
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON agent_finding_overrides
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
