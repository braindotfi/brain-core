-- Production agent token records for docs/contracts/production-agents.md.
--
-- The bearer JWT remains stateless and is never stored. This table stores only
-- the active token id and expiry so production agent-token minting can be
-- idempotent and rotation can revoke the prior jti through the shared JWT
-- revocation store.
--
-- No FK to agents(tenant_id, id): services/api migrations may run before
-- services/execution migrations on a fresh database.

BEGIN;

CREATE TABLE IF NOT EXISTS production_agent_tokens (
  id          TEXT        PRIMARY KEY,               -- token_..., JWT jti
  tenant_id   TEXT        NOT NULL REFERENCES tenants (id),
  agent_id    TEXT        NOT NULL,                  -- agent_...
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_production_agent_tokens_tenant_active
  ON production_agent_tokens (tenant_id, agent_id, expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE production_agent_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON production_agent_tokens
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON production_agent_tokens
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON production_agent_tokens
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE production_agent_tokens FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE production_agent_tokens IS
  'Production BFF service-agent token ids and expiry metadata. Bearer JWT values are never stored.';

COMMIT;
