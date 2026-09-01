-- RFC 0008 Phase 1: one immutable request fact for every request attributable
-- to a cryptographically matched tenant API key. This is operational usage
-- data, not the user-visible audit chain and not yet a billing ledger.

BEGIN;

CREATE TABLE IF NOT EXISTS api_request_meter_events (
  id                        TEXT        PRIMARY KEY,
  request_id                TEXT        NOT NULL,
  tenant_id                 TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_id                    TEXT        NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  occurred_at               TIMESTAMPTZ NOT NULL,
  environment               TEXT        NOT NULL CHECK (environment IN ('sandbox', 'live')),
  access_stage              TEXT        CHECK (
    access_stage IS NULL OR access_stage IN ('demo', 'production_review', 'production')
  ),
  method                    TEXT        NOT NULL,
  route_template            TEXT        NOT NULL,
  operation_id              TEXT        NOT NULL,
  required_scope            TEXT,
  product_family            TEXT        CHECK (
    product_family IS NULL OR product_family IN ('ledger', 'raw', 'audit', 'governance')
  ),
  status_code               INTEGER     NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  outcome                   TEXT        NOT NULL CHECK (
    outcome IN (
      'success', 'client_error', 'server_error', 'scope_rejected',
      'auth_rejected', 'rate_limited'
    )
  ),
  rejection_reason          TEXT,
  rate_limit_count          INTEGER,
  rate_limit_value          INTEGER,
  rate_limit_window_seconds INTEGER,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (rate_limit_count IS NULL OR rate_limit_count >= 0),
  CHECK (rate_limit_value IS NULL OR rate_limit_value > 0),
  CHECK (rate_limit_window_seconds IS NULL OR rate_limit_window_seconds > 0)
);

CREATE INDEX IF NOT EXISTS idx_api_request_meter_tenant_time
  ON api_request_meter_events (tenant_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_api_request_meter_tenant_key_time
  ON api_request_meter_events (tenant_id, key_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_api_request_meter_tenant_scope_operation_time
  ON api_request_meter_events (
    tenant_id, required_scope, operation_id, occurred_at DESC, id DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_api_request_meter_tenant_request
  ON api_request_meter_events (tenant_id, request_id);

ALTER TABLE api_request_meter_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_request_meter_events FORCE ROW LEVEL SECURITY;

CREATE POLICY api_request_meter_tenant_read ON api_request_meter_events
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY api_request_meter_tenant_append ON api_request_meter_events
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

REVOKE UPDATE, DELETE, TRUNCATE ON api_request_meter_events FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON api_request_meter_events FROM brain_app;
  END IF;
END $$;

COMMENT ON TABLE api_request_meter_events IS
  'Append-only tenant API-key request facts. Unknown credentials are excluded and recorded only as security telemetry.';
COMMENT ON COLUMN api_request_meter_events.route_template IS
  'Normalized Fastify route template. Never contains raw path parameters or query values.';
COMMENT ON COLUMN api_request_meter_events.operation_id IS
  'Stable operation identity from the declarative API-key route contract, or unclassified shadow traffic.';

COMMIT;
