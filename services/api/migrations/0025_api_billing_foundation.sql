-- RFC 0008 Phase 3: policy-versioned request units, reproducible rollups,
-- reconciliation, shadow period close, adjustments, and audited entitlement
-- control-plane history. No table in this migration initiates a charge.

BEGIN;

CREATE TABLE IF NOT EXISTS api_metering_policies (
  id                    TEXT        PRIMARY KEY,
  revision              INTEGER     NOT NULL CHECK (revision > 0),
  mode                  TEXT        NOT NULL CHECK (mode IN ('shadow', 'billable')),
  request_unit_name     TEXT        NOT NULL,
  rules                 JSONB       NOT NULL,
  effective_at          TIMESTAMPTZ NOT NULL,
  retired_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (retired_at IS NULL OR retired_at > effective_at)
);

INSERT INTO api_metering_policies (
  id, revision, mode, request_unit_name, rules, effective_at
)
VALUES (
  'requests_v1_shadow',
  1,
  'shadow',
  'api_request',
  '{"unit":1,"when":{"environment":"live","access_stage":"production","outcome":"success"},"charge":false}'::jsonb,
  '2026-09-01T00:00:00Z'
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE api_request_meter_events
  ADD COLUMN IF NOT EXISTS metering_policy_version TEXT
    REFERENCES api_metering_policies(id),
  ADD COLUMN IF NOT EXISTS billable_units BIGINT NOT NULL DEFAULT 0;

UPDATE api_request_meter_events
   SET metering_policy_version = 'requests_v1_shadow'
 WHERE metering_policy_version IS NULL;

ALTER TABLE api_request_meter_events
  ALTER COLUMN metering_policy_version SET NOT NULL,
  DROP CONSTRAINT IF EXISTS api_request_meter_billable_units_check;

ALTER TABLE api_request_meter_events
  ADD CONSTRAINT api_request_meter_billable_units_check
    CHECK (billable_units >= 0);

CREATE TABLE IF NOT EXISTS api_usage_daily_rollups (
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rollup_date           DATE        NOT NULL,
  key_id                TEXT        NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  environment           TEXT        NOT NULL CHECK (environment IN ('sandbox', 'live')),
  method                TEXT        NOT NULL,
  operation_id          TEXT        NOT NULL,
  required_scope        TEXT        NOT NULL,
  product_family        TEXT        NOT NULL,
  outcome               TEXT        NOT NULL,
  metering_policy_version TEXT      NOT NULL REFERENCES api_metering_policies(id),
  request_count         BIGINT      NOT NULL CHECK (request_count >= 0),
  billable_units        BIGINT      NOT NULL CHECK (billable_units >= 0),
  source_last_occurred_at TIMESTAMPTZ NOT NULL,
  source_last_event_id  TEXT        NOT NULL,
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (
    tenant_id, rollup_date, key_id, environment, method, operation_id,
    required_scope, product_family, outcome, metering_policy_version
  )
);

CREATE INDEX IF NOT EXISTS idx_api_usage_rollups_tenant_period
  ON api_usage_daily_rollups (tenant_id, rollup_date, environment);

CREATE TABLE IF NOT EXISTS api_usage_reconciliation_runs (
  id                    TEXT        PRIMARY KEY,
  idempotency_key       TEXT        NOT NULL,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment           TEXT        NOT NULL CHECK (environment IN ('sandbox', 'live')),
  period_start          TIMESTAMPTZ NOT NULL,
  period_end            TIMESTAMPTZ NOT NULL,
  metering_policy_version TEXT      NOT NULL REFERENCES api_metering_policies(id),
  raw_request_count     BIGINT      NOT NULL CHECK (raw_request_count >= 0),
  raw_billable_units    BIGINT      NOT NULL CHECK (raw_billable_units >= 0),
  raw_limiter_decision_count BIGINT NOT NULL CHECK (raw_limiter_decision_count >= 0),
  rollup_request_count  BIGINT      NOT NULL CHECK (rollup_request_count >= 0),
  rollup_billable_units BIGINT      NOT NULL CHECK (rollup_billable_units >= 0),
  gateway_request_count BIGINT,
  limiter_decision_count BIGINT,
  meter_persistence_failures BIGINT NOT NULL DEFAULT 0 CHECK (meter_persistence_failures >= 0),
  status                TEXT        NOT NULL CHECK (status IN ('matched', 'mismatch', 'incomplete')),
  discrepancy           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  source_high_water_at  TIMESTAMPTZ,
  source_high_water_id  TEXT,
  actor                 TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  CHECK (gateway_request_count IS NULL OR gateway_request_count >= 0),
  CHECK (limiter_decision_count IS NULL OR limiter_decision_count >= 0),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_api_usage_reconciliation_tenant_period
  ON api_usage_reconciliation_runs (tenant_id, period_start, period_end, created_at DESC);

CREATE TABLE IF NOT EXISTS api_billing_periods (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment           TEXT        NOT NULL CHECK (environment IN ('sandbox', 'live')),
  period_start          TIMESTAMPTZ NOT NULL,
  period_end            TIMESTAMPTZ NOT NULL,
  mode                  TEXT        NOT NULL CHECK (mode IN ('shadow_closed', 'billable_closed')),
  metering_policy_version TEXT      NOT NULL REFERENCES api_metering_policies(id),
  request_count         BIGINT      NOT NULL CHECK (request_count >= 0),
  billable_units        BIGINT      NOT NULL CHECK (billable_units >= 0),
  chargeable_units      BIGINT      NOT NULL DEFAULT 0 CHECK (chargeable_units >= 0),
  reconciliation_run_id TEXT        NOT NULL,
  source_high_water_at  TIMESTAMPTZ,
  source_high_water_id  TEXT,
  closed_by             TEXT        NOT NULL,
  close_reason          TEXT        NOT NULL,
  closed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  CHECK (mode <> 'shadow_closed' OR chargeable_units = 0),
  FOREIGN KEY (tenant_id, reconciliation_run_id)
    REFERENCES api_usage_reconciliation_runs(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, environment, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS api_billing_adjustments (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  billing_period_id     TEXT        NOT NULL,
  unit_delta            BIGINT      NOT NULL CHECK (unit_delta <> 0),
  reason                TEXT        NOT NULL,
  actor                 TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, billing_period_id)
    REFERENCES api_billing_periods(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS api_entitlement_change_log (
  id                    TEXT        PRIMARY KEY,
  idempotency_key       TEXT        NOT NULL UNIQUE,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment           TEXT        NOT NULL CHECK (environment IN ('sandbox', 'live')),
  key_id                TEXT        REFERENCES api_keys(id) ON DELETE SET NULL,
  change_type           TEXT        NOT NULL CHECK (
    change_type IN ('tier_assigned', 'key_override_set', 'key_override_cleared')
  ),
  before_state          JSONB       NOT NULL,
  after_state           JSONB       NOT NULL,
  actor                 TEXT        NOT NULL,
  reason                TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_entitlement_change_tenant_time
  ON api_entitlement_change_log (tenant_id, created_at DESC, id DESC);

ALTER TABLE api_usage_daily_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage_daily_rollups FORCE ROW LEVEL SECURITY;
ALTER TABLE api_usage_reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage_reconciliation_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE api_billing_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_billing_periods FORCE ROW LEVEL SECURITY;
ALTER TABLE api_billing_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_billing_adjustments FORCE ROW LEVEL SECURITY;
ALTER TABLE api_entitlement_change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_entitlement_change_log FORCE ROW LEVEL SECURITY;

CREATE POLICY api_usage_daily_rollups_tenant_read ON api_usage_daily_rollups
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY api_usage_reconciliation_tenant_read ON api_usage_reconciliation_runs
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY api_billing_periods_tenant_read ON api_billing_periods
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY api_billing_adjustments_tenant_read ON api_billing_adjustments
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY api_entitlement_change_tenant_read ON api_entitlement_change_log
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON api_metering_policies FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON api_usage_daily_rollups FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON api_usage_reconciliation_runs FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON api_billing_periods FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON api_billing_adjustments FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON api_entitlement_change_log FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    GRANT SELECT ON api_metering_policies, api_usage_daily_rollups,
      api_usage_reconciliation_runs, api_billing_periods, api_billing_adjustments,
      api_entitlement_change_log TO brain_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON api_metering_policies,
      api_usage_daily_rollups, api_usage_reconciliation_runs, api_billing_periods,
      api_billing_adjustments, api_entitlement_change_log FROM brain_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_privileged') THEN
    GRANT SELECT ON api_metering_policies, api_request_meter_events, api_keys,
      api_rate_limit_tiers, tenant_api_entitlements, api_key_rate_limit_overrides,
      api_usage_daily_rollups, api_usage_reconciliation_runs, api_billing_periods,
      api_billing_adjustments, api_entitlement_change_log TO brain_privileged;
    GRANT INSERT, UPDATE, DELETE ON api_usage_daily_rollups TO brain_privileged;
    GRANT INSERT ON api_usage_reconciliation_runs, api_billing_periods,
      api_billing_adjustments, api_entitlement_change_log TO brain_privileged;
  END IF;
END $$;

COMMENT ON TABLE api_metering_policies IS
  'Immutable request-unit policies. requests_v1_shadow computes units but never charges.';
COMMENT ON TABLE api_usage_daily_rollups IS
  'Reproducible derived daily usage. Raw api_request_meter_events remain authoritative.';
COMMENT ON TABLE api_usage_reconciliation_runs IS
  'Append-only reconciliation evidence used to gate period close.';
COMMENT ON TABLE api_billing_periods IS
  'Immutable period-close snapshots. Shadow closes always have zero chargeable units.';
COMMENT ON TABLE api_entitlement_change_log IS
  'Same-transaction operator evidence for every entitlement or key-override mutation.';

COMMIT;
