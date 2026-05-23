-- agent_evidence_refs — typed evidence pointers a run grounded on (1a.4 EvidenceRef).
-- Agent Autonomy v3 (1a.3). excerpt is redacted per the run's redaction policy.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_evidence_refs (
  id                  TEXT        PRIMARY KEY,             -- agev_...
  tenant_id           TEXT        NOT NULL,
  run_id              TEXT        NOT NULL REFERENCES agent_runs(id),
  kind                TEXT        NOT NULL,
  ref                 TEXT        NOT NULL,
  source_system       TEXT,                                -- ledger|raw|wiki|chainalysis|...
  object_type         TEXT,
  object_id           TEXT,
  confidence          REAL,
  evidence_timestamp  TIMESTAMPTZ,
  hash                BYTEA,
  excerpt             TEXT,                                -- redacted per redaction_policy
  field_refs          TEXT[],
  stale               BOOLEAN     NOT NULL DEFAULT FALSE,
  weight              REAL,
  required            BOOLEAN,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_evidence_refs_run
  ON agent_evidence_refs (run_id);

ALTER TABLE agent_evidence_refs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_evidence_refs
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON agent_evidence_refs
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
