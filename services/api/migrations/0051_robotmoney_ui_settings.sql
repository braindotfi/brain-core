BEGIN;

CREATE TABLE IF NOT EXISTS tenant_profiles (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  legal_name TEXT,
  dba_name TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT,
  tax_id TEXT,
  industry TEXT,
  jurisdiction TEXT,
  fiscal_year_end TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tenant_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_profiles FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_profiles_tenant_read ON tenant_profiles
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_profiles_tenant_insert ON tenant_profiles
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_profiles_tenant_update ON tenant_profiles
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS tenant_notification_preferences (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  proactive_briefs_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  proactive_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  proactive_alert_channels TEXT[] NOT NULL DEFAULT ARRAY['email']::TEXT[],
  quiet_hours JSONB,
  agent_mute_list TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    proactive_alert_channels <@ ARRAY['email','push','slack']::TEXT[]
  )
);

ALTER TABLE tenant_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_notification_preferences FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_notification_preferences_tenant_read ON tenant_notification_preferences
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_notification_preferences_tenant_insert ON tenant_notification_preferences
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_notification_preferences_tenant_update ON tenant_notification_preferences
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS user_two_factor_methods (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('authenticator','sms','backup_codes')),
  status TEXT NOT NULL CHECK (status IN ('pending','enabled')),
  secret_ref TEXT,
  phone_number TEXT,
  backup_codes_hashes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, method)
);

ALTER TABLE user_two_factor_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_two_factor_methods FORCE ROW LEVEL SECURITY;

CREATE POLICY user_two_factor_methods_tenant_read ON user_two_factor_methods
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY user_two_factor_methods_tenant_insert ON user_two_factor_methods
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY user_two_factor_methods_tenant_update ON user_two_factor_methods
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS trusted_devices (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  ip TEXT,
  user_agent TEXT,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, token_hash)
);

CREATE INDEX IF NOT EXISTS idx_trusted_devices_user_active
  ON trusted_devices (tenant_id, user_id, last_used_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE trusted_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE trusted_devices FORCE ROW LEVEL SECURITY;

CREATE POLICY trusted_devices_tenant_read ON trusted_devices
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY trusted_devices_tenant_insert ON trusted_devices
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY trusted_devices_tenant_update ON trusted_devices
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS exchange_quotes (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_currency TEXT NOT NULL CHECK (source_currency ~ '^[A-Z0-9]{3,6}$'),
  destination_currency TEXT NOT NULL CHECK (destination_currency ~ '^[A-Z0-9]{3,6}$'),
  amount NUMERIC(28, 8) NOT NULL CHECK (amount > 0),
  rate NUMERIC(28, 12) NOT NULL CHECK (rate > 0),
  fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exchange_quotes_tenant_expires
  ON exchange_quotes (tenant_id, expires_at DESC);

ALTER TABLE exchange_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_quotes FORCE ROW LEVEL SECURITY;

CREATE POLICY exchange_quotes_tenant_read ON exchange_quotes
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY exchange_quotes_tenant_insert ON exchange_quotes
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
