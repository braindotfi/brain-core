-- RFC 0008 production readiness: an independent, durable gateway observation
-- stream for reconciling request-meter completeness. These rows are written
-- before request handling and are never derived from api_request_meter_events.

BEGIN;

CREATE TABLE IF NOT EXISTS api_gateway_request_observations (
  tenant_id         TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id        TEXT        NOT NULL,
  key_id            TEXT        NOT NULL,
  environment       TEXT        NOT NULL CHECK (environment IN ('sandbox', 'live')),
  occurred_at       TIMESTAMPTZ NOT NULL,
  limiter_decision  BOOLEAN     NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, request_id),
  FOREIGN KEY (tenant_id, key_id)
    REFERENCES api_keys(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_gateway_observations_tenant_period
  ON api_gateway_request_observations (
    tenant_id, environment, occurred_at, request_id
  );

CREATE TABLE IF NOT EXISTS api_meter_persistence_failure_events (
  tenant_id         TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id        TEXT        NOT NULL,
  key_id            TEXT        NOT NULL,
  environment       TEXT        NOT NULL CHECK (environment IN ('sandbox', 'live')),
  occurred_at       TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, request_id),
  FOREIGN KEY (tenant_id, request_id)
    REFERENCES api_gateway_request_observations(tenant_id, request_id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, key_id)
    REFERENCES api_keys(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_meter_failures_tenant_period
  ON api_meter_persistence_failure_events (
    tenant_id, environment, occurred_at, request_id
  );

ALTER TABLE api_gateway_request_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_gateway_request_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE api_meter_persistence_failure_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_meter_persistence_failure_events FORCE ROW LEVEL SECURITY;

CREATE POLICY api_gateway_observations_tenant_read
  ON api_gateway_request_observations
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY api_gateway_observations_tenant_append
  ON api_gateway_request_observations
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY api_meter_failures_tenant_read
  ON api_meter_persistence_failure_events
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY api_meter_failures_tenant_append
  ON api_meter_persistence_failure_events
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

REVOKE UPDATE, DELETE, TRUNCATE ON api_gateway_request_observations,
  api_meter_persistence_failure_events FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    GRANT SELECT, INSERT ON api_gateway_request_observations,
      api_meter_persistence_failure_events TO brain_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON api_gateway_request_observations,
      api_meter_persistence_failure_events FROM brain_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_privileged') THEN
    GRANT SELECT ON api_gateway_request_observations,
      api_meter_persistence_failure_events TO brain_privileged;
  END IF;
END $$;

COMMENT ON TABLE api_gateway_request_observations IS
  'Append-only, pre-handler known-key gateway observations. Independent from the request meter for reconciliation.';
COMMENT ON TABLE api_meter_persistence_failure_events IS
  'Append-only explicit request-meter append failures. Missing meter rows are also derived from gateway observations at reconciliation.';

COMMIT;
