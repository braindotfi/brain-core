-- RFC 0011 Phase 2: bind one observe-only period to one tenant and add
-- independently reconcilable API and MCP unit evidence. Nothing here starts
-- a period, creates a tenant, or enables enforcement or billing.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM commercial_shadow_observations) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'commercial shadow observations must be empty before tenant binding is installed';
  END IF;
END;
$$;

CREATE TABLE commercial_shadow_contracts (
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  shadow_period_id      TEXT        NOT NULL UNIQUE
                                   REFERENCES commercial_shadow_periods(id) ON DELETE RESTRICT,
  catalog_revision_id   TEXT        NOT NULL REFERENCES api_commercial_tier_catalog(id),
  entitlement_version   INTEGER     NOT NULL CHECK (entitlement_version > 0),
  environment           TEXT        NOT NULL CHECK (environment IN ('sandbox', 'live')),
  api_unit_allowance    BIGINT      NOT NULL CHECK (api_unit_allowance >= 0),
  mcp_unit_allowance    BIGINT      NOT NULL CHECK (mcp_unit_allowance >= 0),
  contract_version      TEXT        NOT NULL DEFAULT 'commercial_shadow_v1'
                                   CHECK (contract_version = 'commercial_shadow_v1'),
  created_by            TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, shadow_period_id)
);

CREATE TABLE mcp_tool_metering_policies (
  id                    TEXT        PRIMARY KEY,
  revision              INTEGER     NOT NULL CHECK (revision > 0),
  mode                  TEXT        NOT NULL CHECK (mode = 'shadow'),
  unit_name             TEXT        NOT NULL CHECK (unit_name = 'fulfilled_tool_call'),
  rules                 JSONB       NOT NULL,
  effective_at          TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO mcp_tool_metering_policies (
  id, revision, mode, unit_name, rules, effective_at
) VALUES (
  'mcp_tools_v1_shadow',
  1,
  'shadow',
  'fulfilled_tool_call',
  '{"unit":1,"when":{"outcome":"success"},"charge":false}'::jsonb,
  '2026-09-11T00:00:00Z'
);

CREATE TABLE mcp_transport_tool_observations (
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  request_id            TEXT        NOT NULL,
  shadow_period_id      TEXT        NOT NULL,
  environment           TEXT        NOT NULL CHECK (environment IN ('sandbox', 'live')),
  principal_type        TEXT        NOT NULL CHECK (principal_type IN ('agent', 'user')),
  principal_id          TEXT        NOT NULL,
  tool_name             TEXT        NOT NULL,
  limiter_decision      BOOLEAN     NOT NULL,
  occurred_at           TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, request_id),
  FOREIGN KEY (tenant_id, shadow_period_id)
    REFERENCES commercial_shadow_contracts(tenant_id, shadow_period_id) ON DELETE RESTRICT
);

CREATE INDEX idx_mcp_transport_observations_period
  ON mcp_transport_tool_observations (
    tenant_id, shadow_period_id, environment, occurred_at, request_id
  );

CREATE TABLE mcp_tool_meter_events (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  request_id            TEXT        NOT NULL,
  shadow_period_id      TEXT        NOT NULL,
  environment           TEXT        NOT NULL CHECK (environment IN ('sandbox', 'live')),
  principal_type        TEXT        NOT NULL CHECK (principal_type IN ('agent', 'user')),
  principal_id          TEXT        NOT NULL,
  tool_name             TEXT        NOT NULL,
  status_code           INTEGER     NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  outcome               TEXT        NOT NULL CHECK (outcome IN (
    'success', 'client_error', 'server_error', 'scope_rejected',
    'auth_rejected', 'rate_limited'
  )),
  rejection_reason      TEXT,
  metering_policy_version TEXT      NOT NULL
                                   REFERENCES mcp_tool_metering_policies(id),
  billable_units        BIGINT      NOT NULL CHECK (billable_units >= 0),
  occurred_at           TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, request_id),
  FOREIGN KEY (tenant_id, shadow_period_id)
    REFERENCES commercial_shadow_contracts(tenant_id, shadow_period_id) ON DELETE RESTRICT
);

CREATE INDEX idx_mcp_tool_meter_events_period
  ON mcp_tool_meter_events (
    tenant_id, shadow_period_id, environment, occurred_at, id
  );

CREATE TABLE mcp_meter_persistence_failure_events (
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  request_id            TEXT        NOT NULL,
  shadow_period_id      TEXT        NOT NULL,
  environment           TEXT        NOT NULL CHECK (environment IN ('sandbox', 'live')),
  occurred_at           TIMESTAMPTZ NOT NULL,
  failure_class         TEXT        NOT NULL CHECK (failure_class = 'meter_append_failed'),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, request_id),
  FOREIGN KEY (tenant_id, request_id)
    REFERENCES mcp_transport_tool_observations(tenant_id, request_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, shadow_period_id)
    REFERENCES commercial_shadow_contracts(tenant_id, shadow_period_id) ON DELETE RESTRICT
);

CREATE TABLE mcp_usage_daily_rollups (
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  shadow_period_id      TEXT        NOT NULL,
  rollup_date           DATE        NOT NULL,
  environment           TEXT        NOT NULL CHECK (environment IN ('sandbox', 'live')),
  tool_name             TEXT        NOT NULL,
  outcome               TEXT        NOT NULL,
  metering_policy_version TEXT      NOT NULL
                                   REFERENCES mcp_tool_metering_policies(id),
  request_count         BIGINT      NOT NULL CHECK (request_count >= 0),
  billable_units        BIGINT      NOT NULL CHECK (billable_units >= 0),
  source_last_occurred_at TIMESTAMPTZ NOT NULL,
  source_last_event_id  TEXT        NOT NULL,
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (
    tenant_id, shadow_period_id, rollup_date, environment, tool_name,
    outcome, metering_policy_version
  ),
  FOREIGN KEY (tenant_id, shadow_period_id)
    REFERENCES commercial_shadow_contracts(tenant_id, shadow_period_id) ON DELETE RESTRICT
);

CREATE TABLE mcp_usage_reconciliation_runs (
  id                    TEXT        PRIMARY KEY,
  idempotency_key       TEXT        NOT NULL,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  shadow_period_id      TEXT        NOT NULL,
  environment           TEXT        NOT NULL CHECK (environment IN ('sandbox', 'live')),
  period_start          TIMESTAMPTZ NOT NULL,
  period_end            TIMESTAMPTZ NOT NULL,
  metering_policy_version TEXT      NOT NULL
                                   REFERENCES mcp_tool_metering_policies(id),
  transport_request_count BIGINT    NOT NULL CHECK (transport_request_count >= 0),
  raw_meter_request_count BIGINT    NOT NULL CHECK (raw_meter_request_count >= 0),
  raw_billable_units    BIGINT      NOT NULL CHECK (raw_billable_units >= 0),
  rollup_request_count  BIGINT      NOT NULL CHECK (rollup_request_count >= 0),
  rollup_billable_units BIGINT      NOT NULL CHECK (rollup_billable_units >= 0),
  missing_meter_count   BIGINT      NOT NULL CHECK (missing_meter_count >= 0),
  unexpected_meter_count BIGINT     NOT NULL CHECK (unexpected_meter_count >= 0),
  meter_persistence_failures BIGINT NOT NULL CHECK (meter_persistence_failures >= 0),
  status                TEXT        NOT NULL CHECK (status IN ('matched', 'mismatch', 'incomplete')),
  discrepancy           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  transport_high_water_at TIMESTAMPTZ,
  transport_high_water_id TEXT,
  meter_high_water_at   TIMESTAMPTZ,
  meter_high_water_id   TEXT,
  actor                 TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, shadow_period_id)
    REFERENCES commercial_shadow_contracts(tenant_id, shadow_period_id) ON DELETE RESTRICT
);

ALTER TABLE commercial_shadow_observations
  ADD COLUMN api_units BIGINT NOT NULL DEFAULT 0 CHECK (api_units >= 0),
  ADD COLUMN mcp_units BIGINT NOT NULL DEFAULT 0 CHECK (mcp_units >= 0),
  ADD COLUMN api_unit_result TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (api_unit_result IN ('within', 'over', 'unresolved')),
  ADD COLUMN mcp_unit_result TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (mcp_unit_result IN ('within', 'over', 'unresolved')),
  ADD COLUMN api_evidence_complete BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN mcp_evidence_complete BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN api_reconciliation_run_id TEXT,
  ADD COLUMN mcp_reconciliation_run_id TEXT,
  ADD CONSTRAINT commercial_shadow_observation_contract_fk
    FOREIGN KEY (tenant_id, shadow_period_id)
      REFERENCES commercial_shadow_contracts(tenant_id, shadow_period_id) ON DELETE RESTRICT,
  ADD CONSTRAINT commercial_shadow_observation_api_reconciliation_fk
    FOREIGN KEY (tenant_id, api_reconciliation_run_id)
      REFERENCES api_usage_reconciliation_runs(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT commercial_shadow_observation_mcp_reconciliation_fk
    FOREIGN KEY (tenant_id, mcp_reconciliation_run_id)
      REFERENCES mcp_usage_reconciliation_runs(tenant_id, id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION reject_commercial_shadow_evidence_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'commercial shadow evidence is immutable';
END;
$$;

CREATE TRIGGER commercial_shadow_contracts_immutable_row
BEFORE UPDATE OR DELETE ON commercial_shadow_contracts
FOR EACH ROW EXECUTE FUNCTION reject_commercial_shadow_evidence_mutation();
CREATE TRIGGER commercial_shadow_contracts_immutable_truncate
BEFORE TRUNCATE ON commercial_shadow_contracts
FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_shadow_evidence_mutation();
CREATE TRIGGER mcp_tool_metering_policies_immutable_row
BEFORE UPDATE OR DELETE ON mcp_tool_metering_policies
FOR EACH ROW EXECUTE FUNCTION reject_commercial_shadow_evidence_mutation();
CREATE TRIGGER mcp_tool_metering_policies_immutable_truncate
BEFORE TRUNCATE ON mcp_tool_metering_policies
FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_shadow_evidence_mutation();
CREATE TRIGGER commercial_shadow_observations_immutable_row
BEFORE UPDATE OR DELETE ON commercial_shadow_observations
FOR EACH ROW EXECUTE FUNCTION reject_commercial_shadow_evidence_mutation();
CREATE TRIGGER commercial_shadow_observations_immutable_truncate
BEFORE TRUNCATE ON commercial_shadow_observations
FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_shadow_evidence_mutation();
CREATE TRIGGER mcp_transport_observations_immutable_row
BEFORE UPDATE OR DELETE ON mcp_transport_tool_observations
FOR EACH ROW EXECUTE FUNCTION reject_commercial_shadow_evidence_mutation();
CREATE TRIGGER mcp_transport_observations_immutable_truncate
BEFORE TRUNCATE ON mcp_transport_tool_observations
FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_shadow_evidence_mutation();
CREATE TRIGGER mcp_tool_meter_events_immutable_row
BEFORE UPDATE OR DELETE ON mcp_tool_meter_events
FOR EACH ROW EXECUTE FUNCTION reject_commercial_shadow_evidence_mutation();
CREATE TRIGGER mcp_tool_meter_events_immutable_truncate
BEFORE TRUNCATE ON mcp_tool_meter_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_shadow_evidence_mutation();
CREATE TRIGGER mcp_meter_failures_immutable_row
BEFORE UPDATE OR DELETE ON mcp_meter_persistence_failure_events
FOR EACH ROW EXECUTE FUNCTION reject_commercial_shadow_evidence_mutation();
CREATE TRIGGER mcp_meter_failures_immutable_truncate
BEFORE TRUNCATE ON mcp_meter_persistence_failure_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_shadow_evidence_mutation();
CREATE TRIGGER mcp_usage_reconciliations_immutable_row
BEFORE UPDATE OR DELETE ON mcp_usage_reconciliation_runs
FOR EACH ROW EXECUTE FUNCTION reject_commercial_shadow_evidence_mutation();
CREATE TRIGGER mcp_usage_reconciliations_immutable_truncate
BEFORE TRUNCATE ON mcp_usage_reconciliation_runs
FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_shadow_evidence_mutation();

ALTER TABLE commercial_shadow_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_shadow_contracts FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_transport_tool_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_transport_tool_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_tool_meter_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_tool_meter_events FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_meter_persistence_failure_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_meter_persistence_failure_events FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_usage_daily_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_usage_daily_rollups FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_usage_reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_usage_reconciliation_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY commercial_shadow_contracts_tenant_read ON commercial_shadow_contracts
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY mcp_transport_observations_tenant_read ON mcp_transport_tool_observations
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY mcp_transport_observations_tenant_append ON mcp_transport_tool_observations
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY mcp_tool_meter_tenant_read ON mcp_tool_meter_events
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY mcp_tool_meter_tenant_append ON mcp_tool_meter_events
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY mcp_meter_failures_tenant_read ON mcp_meter_persistence_failure_events
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY mcp_meter_failures_tenant_append ON mcp_meter_persistence_failure_events
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY mcp_usage_rollups_tenant_read ON mcp_usage_daily_rollups
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY mcp_usage_reconciliation_tenant_read ON mcp_usage_reconciliation_runs
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));

REVOKE ALL ON FUNCTION reject_commercial_shadow_evidence_mutation() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON commercial_shadow_contracts,
  mcp_tool_metering_policies, mcp_transport_tool_observations,
  mcp_tool_meter_events, mcp_meter_persistence_failure_events,
  mcp_usage_daily_rollups, mcp_usage_reconciliation_runs FROM PUBLIC;

DO $$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'brain_app', 'brain_privileged', 'brain_wiki_reader', 'brain_mcp_reader',
    'brain_raw_worker', 'brain_canonical_projector', 'brain_ledger_projector',
    'brain_execution_worker', 'brain_audit_verifier', 'brain_audit_publisher',
    'brain_resolver', 'brain_tenant_deletion', 'brain_surface_gateway',
    'brain_surface_audit_writer', 'brain_auth', 'brain_auth_audit_writer'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON commercial_shadow_contracts, commercial_shadow_observations, mcp_tool_metering_policies, mcp_transport_tool_observations, mcp_tool_meter_events, mcp_meter_persistence_failure_events, mcp_usage_daily_rollups, mcp_usage_reconciliation_runs FROM %I',
        runtime_role
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    GRANT SELECT ON commercial_shadow_contracts, commercial_shadow_observations,
      mcp_tool_metering_policies,
      mcp_transport_tool_observations, mcp_tool_meter_events,
      mcp_meter_persistence_failure_events, mcp_usage_daily_rollups,
      mcp_usage_reconciliation_runs TO brain_app;
    GRANT INSERT ON commercial_shadow_observations,
      mcp_transport_tool_observations, mcp_tool_meter_events,
      mcp_meter_persistence_failure_events TO brain_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_privileged') THEN
    GRANT SELECT ON commercial_shadow_contracts, commercial_shadow_observations,
      mcp_tool_metering_policies,
      mcp_transport_tool_observations, mcp_tool_meter_events,
      mcp_meter_persistence_failure_events, mcp_usage_daily_rollups,
      mcp_usage_reconciliation_runs TO brain_privileged;
    GRANT INSERT, UPDATE, DELETE ON mcp_usage_daily_rollups TO brain_privileged;
    GRANT INSERT ON commercial_shadow_observations,
      mcp_usage_reconciliation_runs TO brain_privileged;
  END IF;
END $$;

COMMENT ON TABLE commercial_shadow_contracts IS
  'Immutable one-tenant, one-period shadow contract with pinned API and MCP allowances. Created only by the later guarded operator.';
COMMENT ON TABLE mcp_tool_metering_policies IS
  'Immutable shadow-only MCP unit policy. The policy never creates a charge.';
COMMENT ON TABLE mcp_transport_tool_observations IS
  'Append-only pre-handler MCP tool-call observations independent from the logical tool meter.';
COMMENT ON TABLE mcp_tool_meter_events IS
  'Append-only logical MCP tool-call facts. One unit is one successfully fulfilled tool call.';
COMMENT ON TABLE mcp_usage_daily_rollups IS
  'Reproducible MCP daily usage derived only from mcp_tool_meter_events.';
COMMENT ON TABLE mcp_usage_reconciliation_runs IS
  'Append-only comparison of MCP transport observations, meter facts, and derived rollups.';

COMMIT;
