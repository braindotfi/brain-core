-- Exchange-only API keys for durable machine credentials.
--
-- These rows are deliberately separate from commercial api_keys. A
-- brain_ak_* value can be presented only to auth.brain.fi/token and can never
-- authenticate an API resource request directly. The plaintext is returned
-- once; only an HMAC-SHA-256 digest is stored.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_api_keys (
  id              TEXT        PRIMARY KEY,
  tenant_id       TEXT        NOT NULL REFERENCES tenants (id),
  agent_id        TEXT        NOT NULL,
  profile         TEXT        NOT NULL
                              CHECK (profile IN ('document_extractor_v1', 'bff_service_v1')),
  environment     TEXT        NOT NULL CHECK (environment IN ('test', 'live')),
  scopes          TEXT[]      NOT NULL,
  hashed_secret   TEXT        NOT NULL UNIQUE,
  key_prefix      TEXT        NOT NULL,
  key_last4       TEXT        NOT NULL,
  name            TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  rotated_from_id TEXT        REFERENCES agent_api_keys (id),
  CHECK (
    (profile = 'document_extractor_v1' AND scopes = ARRAY['raw:write']::TEXT[])
    OR
    (profile = 'bff_service_v1' AND scopes = ARRAY[
      'ledger:read', 'wiki:read', 'raw:read', 'raw:write', 'policy:read',
      'execution:read', 'execution:propose', 'payment_intent:propose', 'audit:read'
    ]::TEXT[])
  ),
  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agent_api_keys_tenant_agent
  ON agent_api_keys (tenant_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_api_keys_active
  ON agent_api_keys (tenant_id, agent_id, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_agent_api_keys_rotated_from
  ON agent_api_keys (rotated_from_id)
  WHERE rotated_from_id IS NOT NULL;

ALTER TABLE agent_api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_api_keys
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON agent_api_keys
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON agent_api_keys
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE agent_api_keys FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE agent_api_keys IS
  'Exchange-only machine API keys bound to one active agent and one server-owned scope profile. Plaintext brain_ak_test_ or brain_ak_live_ secrets are returned once and never stored.';
COMMENT ON COLUMN agent_api_keys.hashed_secret IS
  'HMAC-SHA-256 digest keyed by BRAIN_AGENT_API_KEY_PEPPER.';

COMMIT;
