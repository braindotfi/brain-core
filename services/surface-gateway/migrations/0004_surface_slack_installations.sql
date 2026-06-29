BEGIN;

CREATE TABLE IF NOT EXISTS surface_slack_installations (
  tenant_id            TEXT        NOT NULL,
  team_id              TEXT        NOT NULL,
  bot_token_encrypted  BYTEA       NOT NULL,
  credential_key_id    TEXT        NOT NULL,
  bot_user_id          TEXT        NOT NULL,
  scopes               TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  installed_by         TEXT        NOT NULL,
  installed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  status               TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  revoked_at           TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, team_id),
  UNIQUE (team_id)
);

CREATE TABLE IF NOT EXISTS surface_slack_install_nonces (
  tenant_id     TEXT        NOT NULL,
  nonce         TEXT        NOT NULL,
  installed_by  TEXT        NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_surface_slack_install_nonces_expiry
  ON surface_slack_install_nonces (expires_at);

ALTER TABLE surface_slack_installations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surface_slack_installations
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    OR team_id = current_setting('app.slack_team_id', true)
  );
CREATE POLICY tenant_isolation_write ON surface_slack_installations
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON surface_slack_installations
  FOR UPDATE USING (
    tenant_id = current_setting('app.tenant_id', true)
    OR team_id = current_setting('app.slack_team_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    OR team_id = current_setting('app.slack_team_id', true)
  );
ALTER TABLE surface_slack_installations FORCE ROW LEVEL SECURITY;

ALTER TABLE surface_slack_install_nonces ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surface_slack_install_nonces
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON surface_slack_install_nonces
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON surface_slack_install_nonces
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE surface_slack_install_nonces FORCE ROW LEVEL SECURITY;

COMMIT;
