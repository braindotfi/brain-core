-- Agent-to-agent saga semantics (Agent Autonomy v3, 3.2).
-- When agent A depends on agent B's output (e.g. Payment depends on a
-- Reconciliation match), a partial failure needs compensation. A saga records
-- forward steps + their compensations; on failure the executor runs the
-- compensations of completed steps in reverse, each emitting its own audit event.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_action_sagas (
  id            TEXT        PRIMARY KEY,                   -- agsg_...
  tenant_id     TEXT        NOT NULL,
  agent_id      TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'completed', 'compensated', 'failed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agent_saga_steps (
  id                   TEXT        PRIMARY KEY,            -- agss_...
  tenant_id            TEXT        NOT NULL,
  saga_id              TEXT        NOT NULL REFERENCES agent_action_sagas(id),
  step_index           INTEGER     NOT NULL,
  name                 TEXT        NOT NULL,
  status               TEXT        NOT NULL                -- pending|forward_done|compensated|forward_failed|compensation_failed
                        CHECK (status IN (
                          'pending', 'forward_done', 'compensated',
                          'forward_failed', 'compensation_failed'
                        )),
  forward_result       JSONB,
  compensation_result  JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (saga_id, step_index)
);

CREATE INDEX IF NOT EXISTS idx_agent_saga_steps_saga ON agent_saga_steps (saga_id, step_index);

ALTER TABLE agent_action_sagas ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_action_sagas
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON agent_action_sagas
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON agent_action_sagas
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE agent_saga_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_saga_steps
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON agent_saga_steps
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON agent_saga_steps
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
