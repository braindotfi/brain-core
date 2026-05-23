-- agent_run_steps — ordered substeps of a run (route, resolve_action,
-- gather_evidence, gate_dryrun, propose, ...). Agent Autonomy v3 (1a.3).

BEGIN;

CREATE TABLE IF NOT EXISTS agent_run_steps (
  id            TEXT        PRIMARY KEY,                   -- agrs_...
  tenant_id     TEXT        NOT NULL,
  run_id        TEXT        NOT NULL REFERENCES agent_runs(id),
  step_index    INT         NOT NULL,
  kind          TEXT        NOT NULL,                      -- route|resolve_action|gather_evidence|gate_dryrun|propose
  status        TEXT        NOT NULL,
  detail        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_index)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_steps_run
  ON agent_run_steps (run_id, step_index);

ALTER TABLE agent_run_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_run_steps
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON agent_run_steps
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
