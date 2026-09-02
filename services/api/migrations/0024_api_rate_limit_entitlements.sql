-- RFC 0008 Phase 2: immutable rate-tier catalog, server-owned tenant
-- entitlements, restrictive key overrides, and reproducible limiter evidence.

BEGIN;

CREATE TABLE IF NOT EXISTS api_rate_limit_tiers (
  id                    TEXT        PRIMARY KEY,
  display_name          TEXT        NOT NULL,
  revision              INTEGER     NOT NULL CHECK (revision > 0),
  window_seconds        INTEGER     NOT NULL CHECK (window_seconds > 0),
  key_limit             INTEGER     NOT NULL CHECK (key_limit > 0),
  tenant_limit          INTEGER     NOT NULL CHECK (tenant_limit > 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (display_name, revision),
  CHECK (tenant_limit >= key_limit)
);

INSERT INTO api_rate_limit_tiers (
  id, display_name, revision, window_seconds, key_limit, tenant_limit
)
VALUES
  ('sandbox_demo_v1', 'Demo',       1, 60,  600,  6000),
  ('starter_v1',      'Starter',    1, 60,   60,   600),
  ('standard_v1',     'Standard',   1, 60,  300,  3000),
  ('scale_v1',        'Scale',      1, 60,  600,  6000),
  ('enterprise_v1',   'Enterprise', 1, 60, 3000, 30000)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS tenant_api_entitlements (
  tenant_id            TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment          TEXT        NOT NULL CHECK (environment IN ('sandbox', 'live')),
  tier_id               TEXT        NOT NULL REFERENCES api_rate_limit_tiers(id),
  version               INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
  status                TEXT        NOT NULL DEFAULT 'active'
                                   CHECK (status IN ('active', 'suspended')),
  source                TEXT        NOT NULL,
  effective_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, environment)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_api_keys_tenant_id_id
  ON api_keys (tenant_id, id);

CREATE TABLE IF NOT EXISTS api_key_rate_limit_overrides (
  key_id                TEXT        PRIMARY KEY,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_limit             INTEGER     NOT NULL CHECK (key_limit > 0),
  version               INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
  source                TEXT        NOT NULL,
  reason                TEXT        NOT NULL,
  authorized_by         TEXT        NOT NULL,
  effective_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > effective_at),
  FOREIGN KEY (tenant_id, key_id)
    REFERENCES api_keys(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_api_entitlements_tier
  ON tenant_api_entitlements (tier_id, environment, status);

CREATE INDEX IF NOT EXISTS idx_api_key_rate_limit_overrides_tenant
  ON api_key_rate_limit_overrides (tenant_id, key_id);

INSERT INTO tenant_api_entitlements (
  tenant_id, environment, tier_id, source
)
SELECT id, 'sandbox', 'sandbox_demo_v1', 'migration_default'
  FROM tenants
ON CONFLICT (tenant_id, environment) DO NOTHING;

INSERT INTO tenant_api_entitlements (
  tenant_id, environment, tier_id, source
)
SELECT id, 'live', 'scale_v1', 'migration_preserve_legacy_600'
  FROM tenants
ON CONFLICT (tenant_id, environment) DO NOTHING;

CREATE OR REPLACE FUNCTION create_default_api_entitlements()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Resolve the entitlement table in the same schema as the trigger's tenants
  -- table. Production uses public, while integration tests apply migrations to
  -- isolated schemas. Identifier formatting keeps the SECURITY DEFINER target
  -- explicit without trusting the caller's search_path.
  EXECUTE format(
    'INSERT INTO %I.tenant_api_entitlements '
    '(tenant_id, environment, tier_id, source) '
    'VALUES '
    '($1, ''sandbox'', ''sandbox_demo_v1'', ''tenant_provisioning''), '
    '($1, ''live'', ''starter_v1'', ''tenant_provisioning'') '
    'ON CONFLICT (tenant_id, environment) DO NOTHING',
    TG_TABLE_SCHEMA
  ) USING NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenants_create_default_api_entitlements ON tenants;
CREATE TRIGGER tenants_create_default_api_entitlements
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION create_default_api_entitlements();

ALTER TABLE tenant_api_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_api_entitlements FORCE ROW LEVEL SECURITY;
ALTER TABLE api_key_rate_limit_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_rate_limit_overrides FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_api_entitlements_read ON tenant_api_entitlements
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_api_entitlements_operator_write ON tenant_api_entitlements
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY api_key_rate_limit_overrides_read ON api_key_rate_limit_overrides
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY api_key_rate_limit_overrides_operator_write ON api_key_rate_limit_overrides
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE api_request_meter_events
  ADD COLUMN IF NOT EXISTS effective_tier_id TEXT REFERENCES api_rate_limit_tiers(id),
  ADD COLUMN IF NOT EXISTS entitlement_version INTEGER,
  ADD COLUMN IF NOT EXISTS rate_limit_tenant_count INTEGER,
  ADD COLUMN IF NOT EXISTS rate_limit_tenant_value INTEGER,
  ADD COLUMN IF NOT EXISTS rate_limit_rejected_by TEXT;

ALTER TABLE api_request_meter_events
  DROP CONSTRAINT IF EXISTS api_request_meter_entitlement_version_check,
  DROP CONSTRAINT IF EXISTS api_request_meter_tenant_count_check,
  DROP CONSTRAINT IF EXISTS api_request_meter_tenant_value_check,
  DROP CONSTRAINT IF EXISTS api_request_meter_rejected_by_check;

ALTER TABLE api_request_meter_events
  ADD CONSTRAINT api_request_meter_entitlement_version_check
    CHECK (entitlement_version IS NULL OR entitlement_version > 0),
  ADD CONSTRAINT api_request_meter_tenant_count_check
    CHECK (rate_limit_tenant_count IS NULL OR rate_limit_tenant_count >= 0),
  ADD CONSTRAINT api_request_meter_tenant_value_check
    CHECK (rate_limit_tenant_value IS NULL OR rate_limit_tenant_value > 0),
  ADD CONSTRAINT api_request_meter_rejected_by_check
    CHECK (
      rate_limit_rejected_by IS NULL OR
      rate_limit_rejected_by IN ('key', 'tenant', 'key_and_tenant')
    );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON api_rate_limit_tiers FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON tenant_api_entitlements FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON api_key_rate_limit_overrides FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON api_rate_limit_tiers FROM brain_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON tenant_api_entitlements FROM brain_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON api_key_rate_limit_overrides FROM brain_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_privileged') THEN
    GRANT SELECT, INSERT, UPDATE ON tenant_api_entitlements TO brain_privileged;
    GRANT SELECT, INSERT, UPDATE, DELETE ON api_key_rate_limit_overrides TO brain_privileged;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_resolver') THEN
    GRANT SELECT ON api_rate_limit_tiers TO brain_resolver;
    GRANT SELECT ON tenant_api_entitlements TO brain_resolver;
    GRANT SELECT ON api_key_rate_limit_overrides TO brain_resolver;
  END IF;
END $$;

COMMENT ON TABLE api_rate_limit_tiers IS
  'Immutable server-owned API rate-limit tier revisions.';
COMMENT ON TABLE tenant_api_entitlements IS
  'Effective tenant API tier by key environment. Tenant members cannot mutate this table.';
COMMENT ON TABLE api_key_rate_limit_overrides IS
  'Operator-owned per-key restrictions. Runtime resolution always caps the override at the tenant tier key limit.';

COMMIT;
