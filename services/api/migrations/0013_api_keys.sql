-- Per-customer API-key authentication (token-exchange model). A customer
-- holding an issued key exchanges it (POST /v1/auth/api-key) for a
-- short-lived agent JWT; keys are issued only by the platform operator
-- (POST /v1/tenants/:tenantId/api-keys, platform-secret gated) and are never
-- self-minted. Shape mirrors session_refresh_tokens (execution 0025): only
-- the sha256 hash of the secret is stored, RLS is tenant-isolated and forced,
-- and cross-tenant lookup by hash goes through the brain_resolver role.
--
-- No FK to agents(tenant_id, id): the migration runner applies services/api/
-- migrations before services/execution/migrations (lexicographic service
-- order), so agents does not exist yet when this file would run on a fresh
-- database.

BEGIN;

CREATE TABLE IF NOT EXISTS api_keys (
  token_hash    TEXT        PRIMARY KEY,
  key_id        TEXT        NOT NULL UNIQUE,          -- akey_..., public id
  tenant_id     TEXT        NOT NULL REFERENCES tenants (id),
  agent_id      TEXT        NOT NULL,
  scopes        JSONB       NOT NULL,
  name          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,                          -- NULL = no expiry
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key_id ON api_keys (key_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_keys
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON api_keys
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON api_keys
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE api_keys IS
  'Per-customer API keys for the token-exchange auth model (POST /v1/auth/api-key). Only the sha256 hash of the plaintext brain_sk_... key is stored; the plaintext is returned once, at issuance, and never again.';

COMMIT;
