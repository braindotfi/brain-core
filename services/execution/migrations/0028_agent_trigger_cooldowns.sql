-- Idempotency state for scheduled agent trigger producers.
-- The Collections overdue scanner claims one natural key per receivable and
-- aging tier before it calls the existing AgentRunService path. Tenant-scoped
-- RLS keeps claim and result updates isolated to one tenant.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_trigger_cooldowns (
  id                 BIGSERIAL   PRIMARY KEY,
  tenant_id          TEXT        NOT NULL,
  trigger_key        TEXT        NOT NULL,
  agent_key          TEXT        NOT NULL,
  event              TEXT        NOT NULL,
  receivable_kind    TEXT        NOT NULL,
  receivable_id      TEXT        NOT NULL,
  aging_tier         TEXT        NOT NULL,
  last_enqueued_at   TIMESTAMPTZ NOT NULL,
  last_status        TEXT        NOT NULL,
  run_id             TEXT,
  proposal_id        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, trigger_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_trigger_cooldowns_tenant_agent
  ON agent_trigger_cooldowns (tenant_id, agent_key, updated_at DESC);

ALTER TABLE agent_trigger_cooldowns ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_trigger_cooldowns
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON agent_trigger_cooldowns
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON agent_trigger_cooldowns
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE agent_trigger_cooldowns FORCE ROW LEVEL SECURITY;

COMMIT;
