-- Brain agents table. Internal agents pre-seeded; external agents registered
-- via /execution/agents/register with §8.4 state machine.

BEGIN;

CREATE TABLE IF NOT EXISTS agents (
  id                TEXT        PRIMARY KEY,              -- agent_...
  tenant_id         TEXT        NOT NULL,
  kind              TEXT        NOT NULL
                     CHECK (kind IN ('internal','external')),
  role              TEXT        NOT NULL,                -- reconciliation|payment|anomaly|partner
  display_name      TEXT        NOT NULL,
  scope_hash        BYTEA,                               -- matches BrainMCPAgentRegistry
  onchain_address   TEXT,
  state             TEXT        NOT NULL
                     CHECK (state IN ('pending_onchain','active','revoked','failed')),
  registered_tx     TEXT,
  registered_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agents_tenant_state
  ON agents (tenant_id, state);

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON agents
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON agents
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
