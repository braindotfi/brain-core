-- RFC 0011 Phase 4: durable daily workload evidence and scheduler health.
-- The workload runner can mutate these relations only through narrow
-- SECURITY DEFINER functions. Final run evidence is append-only.

BEGIN;

CREATE TABLE commercial_shadow_daily_runs (
  tenant_id                    TEXT        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  shadow_period_id             TEXT        NOT NULL,
  run_date                     DATE        NOT NULL,
  scheduled_for                TIMESTAMPTZ NOT NULL,
  deployed_sha                 TEXT        NOT NULL CHECK (deployed_sha ~ '^[0-9a-f]{40}$'),
  started_at                   TIMESTAMPTZ NOT NULL,
  completed_at                 TIMESTAMPTZ NOT NULL,
  api_expected_requests        INTEGER     NOT NULL CHECK (api_expected_requests IN (500, 1000)),
  api_completed_requests       INTEGER     NOT NULL CHECK (api_completed_requests >= 0),
  mcp_expected_requests        INTEGER     NOT NULL CHECK (mcp_expected_requests IN (50, 100)),
  mcp_completed_requests       INTEGER     NOT NULL CHECK (mcp_completed_requests >= 0),
  api_reconciliation_run_id    TEXT        NOT NULL,
  mcp_reconciliation_run_id    TEXT        NOT NULL,
  observation_id               TEXT        NOT NULL,
  run_reference                TEXT        NOT NULL,
  evidence                     JSONB       NOT NULL,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_date),
  UNIQUE (tenant_id, observation_id),
  FOREIGN KEY (tenant_id, shadow_period_id)
    REFERENCES commercial_shadow_contracts(tenant_id, shadow_period_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, api_reconciliation_run_id)
    REFERENCES api_usage_reconciliation_runs(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, mcp_reconciliation_run_id)
    REFERENCES mcp_usage_reconciliation_runs(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, observation_id)
    REFERENCES commercial_shadow_observations(tenant_id, id) ON DELETE RESTRICT,
  CHECK (scheduled_for = (run_date::timestamp AT TIME ZONE 'UTC') + interval '1 hour 15 minutes'),
  CHECK (started_at >= scheduled_for - interval '26 hours'),
  CHECK (completed_at >= started_at AND completed_at <= started_at + interval '4 hours'),
  CHECK (api_completed_requests = api_expected_requests),
  CHECK (mcp_completed_requests = mcp_expected_requests),
  CHECK (
    CASE WHEN extract(isodow FROM run_date) IN (6, 7)
      THEN api_expected_requests = 500 AND mcp_expected_requests = 50
      ELSE api_expected_requests = 1000 AND mcp_expected_requests = 100
    END
  ),
  CHECK (jsonb_typeof(evidence) = 'object')
);

ALTER TABLE commercial_shadow_daily_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_shadow_daily_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY commercial_shadow_daily_runs_tenant_read
  ON commercial_shadow_daily_runs FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE TRIGGER commercial_shadow_daily_runs_immutable_row
BEFORE UPDATE OR DELETE ON commercial_shadow_daily_runs
FOR EACH ROW EXECUTE FUNCTION reject_commercial_shadow_evidence_mutation();
CREATE TRIGGER commercial_shadow_daily_runs_immutable_truncate
BEFORE TRUNCATE ON commercial_shadow_daily_runs
FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_shadow_evidence_mutation();

CREATE OR REPLACE FUNCTION require_commercial_shadow_daily_runs_for_completion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_complete_days INTEGER;
  v_tenant_id TEXT;
BEGIN
  IF NEW.state = 'completed' AND OLD.state <> 'completed' THEN
    SELECT contract.tenant_id INTO STRICT v_tenant_id
      FROM commercial_shadow_contracts contract
     WHERE contract.shadow_period_id = NEW.id;
    SELECT count(*) INTO v_complete_days
      FROM commercial_shadow_daily_runs daily
     WHERE daily.tenant_id = v_tenant_id
       AND daily.shadow_period_id = NEW.id
       AND daily.run_date >= (NEW.started_at AT TIME ZONE 'UTC')::date
       AND daily.run_date <= (clock_timestamp() AT TIME ZONE 'UTC')::date;
    IF v_complete_days < 30 THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = '30 complete scheduler-backed daily runs are required';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER commercial_shadow_completion_requires_daily_runs
BEFORE UPDATE OF state ON commercial_shadow_periods
FOR EACH ROW EXECUTE FUNCTION require_commercial_shadow_daily_runs_for_completion();

CREATE OR REPLACE FUNCTION write_commercial_shadow_scheduler_heartbeat(
  p_deployed_sha TEXT,
  p_state TEXT,
  p_checked_at TIMESTAMPTZ,
  p_next_run_at TIMESTAMPTZ,
  p_run_reference TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_deployed_sha !~ '^[0-9a-f]{40}$'
     OR p_state NOT IN ('ready', 'unhealthy')
     OR p_checked_at > clock_timestamp() + interval '1 minute'
     OR p_checked_at < clock_timestamp() - interval '15 minutes'
     OR p_next_run_at <= p_checked_at
     OR p_next_run_at > p_checked_at + interval '26 hours'
     OR p_run_reference IS NULL
     OR char_length(p_run_reference) NOT BETWEEN 1 AND 200
     OR p_run_reference ~ E'[\r\n]' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid commercial shadow heartbeat';
  END IF;

  INSERT INTO commercial_shadow_scheduler_heartbeats (
    environment, scheduler_revision, deployed_sha, state, checked_at,
    next_run_at, run_reference, updated_at
  ) VALUES (
    'live', 'commercial_shadow_daily_v1', p_deployed_sha, p_state,
    p_checked_at, p_next_run_at, p_run_reference, clock_timestamp()
  )
  ON CONFLICT (environment) DO UPDATE SET
    scheduler_revision = EXCLUDED.scheduler_revision,
    deployed_sha = EXCLUDED.deployed_sha,
    state = EXCLUDED.state,
    checked_at = EXCLUDED.checked_at,
    next_run_at = EXCLUDED.next_run_at,
    run_reference = EXCLUDED.run_reference,
    updated_at = clock_timestamp();
END;
$$;

CREATE OR REPLACE FUNCTION record_internal_commercial_shadow_daily_run(
  p_tenant_id TEXT,
  p_shadow_period_id TEXT,
  p_run_date DATE,
  p_scheduled_for TIMESTAMPTZ,
  p_deployed_sha TEXT,
  p_started_at TIMESTAMPTZ,
  p_completed_at TIMESTAMPTZ,
  p_api_expected INTEGER,
  p_api_completed INTEGER,
  p_mcp_expected INTEGER,
  p_mcp_completed INTEGER,
  p_api_reconciliation_run_id TEXT,
  p_mcp_reconciliation_run_id TEXT,
  p_observation_id TEXT,
  p_run_reference TEXT,
  p_evidence JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM commercial_shadow_periods period
      JOIN commercial_shadow_contracts contract
        ON contract.tenant_id = period.tenant_id
       AND contract.shadow_period_id = period.id
      JOIN tenants tenant ON tenant.id = period.tenant_id
     WHERE period.tenant_id = p_tenant_id
       AND period.id = p_shadow_period_id
       AND period.state = 'running'
       AND period.completed_at IS NULL
       AND contract.environment = 'live'
       AND tenant.data_profile = 'internal_commercial_shadow_v1'
       AND tenant.access_stage = 'production'
       AND tenant.do_not_delete = TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'active internal shadow contract missing';
  END IF;
  PERFORM assert_internal_commercial_shadow_zero_billing(p_tenant_id);
  IF NOT EXISTS (
    SELECT 1 FROM commercial_billing_exclusions
     WHERE tenant_id = p_tenant_id
       AND exclusion_kind = 'internal_commercial_shadow'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'billing exclusion missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM api_usage_reconciliation_runs
     WHERE tenant_id = p_tenant_id AND id = p_api_reconciliation_run_id
       AND period_start = (
         SELECT started_at FROM commercial_shadow_periods
          WHERE tenant_id = p_tenant_id AND id = p_shadow_period_id
       )
       AND period_end = p_completed_at
       AND environment = 'live' AND status = 'matched'
       AND meter_persistence_failures = 0
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'matched API reconciliation missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM mcp_usage_reconciliation_runs
     WHERE tenant_id = p_tenant_id AND id = p_mcp_reconciliation_run_id
       AND shadow_period_id = p_shadow_period_id
       AND period_start = (
         SELECT started_at FROM commercial_shadow_periods
          WHERE tenant_id = p_tenant_id AND id = p_shadow_period_id
       )
       AND period_end = p_completed_at
       AND environment = 'live' AND status = 'matched'
       AND missing_meter_count = 0 AND unexpected_meter_count = 0
       AND meter_persistence_failures = 0
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'matched MCP reconciliation missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM commercial_shadow_observations
     WHERE tenant_id = p_tenant_id AND id = p_observation_id
       AND shadow_period_id = p_shadow_period_id
       AND api_reconciliation_run_id = p_api_reconciliation_run_id
       AND mcp_reconciliation_run_id = p_mcp_reconciliation_run_id
       AND api_evidence_complete = TRUE AND mcp_evidence_complete = TRUE
       AND enforcement_applied = FALSE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'complete shadow observation missing';
  END IF;

  INSERT INTO commercial_shadow_daily_runs (
    tenant_id, shadow_period_id, run_date, scheduled_for, deployed_sha,
    started_at, completed_at, api_expected_requests, api_completed_requests,
    mcp_expected_requests, mcp_completed_requests, api_reconciliation_run_id,
    mcp_reconciliation_run_id, observation_id, run_reference, evidence
  ) VALUES (
    p_tenant_id, p_shadow_period_id, p_run_date, p_scheduled_for, p_deployed_sha,
    p_started_at, p_completed_at, p_api_expected, p_api_completed,
    p_mcp_expected, p_mcp_completed, p_api_reconciliation_run_id,
    p_mcp_reconciliation_run_id, p_observation_id, p_run_reference, p_evidence
  );
END;
$$;

CREATE OR REPLACE FUNCTION report_internal_commercial_shadow_day(p_run_date DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH selected AS (
    SELECT contract.tenant_id, contract.shadow_period_id, period.started_at,
           (p_run_date::timestamp AT TIME ZONE 'UTC') + interval '1 hour 15 minutes' AS scheduled_for
      FROM commercial_shadow_contracts contract
      JOIN commercial_shadow_periods period ON period.id = contract.shadow_period_id
      JOIN tenants tenant ON tenant.id = contract.tenant_id
     WHERE tenant.data_profile = 'internal_commercial_shadow_v1'
     ORDER BY period.created_at DESC
     LIMIT 1
  ), state_at_schedule AS (
    SELECT selected.*,
           COALESCE((
             SELECT transition.to_state
               FROM commercial_shadow_state_transitions transition
              WHERE transition.tenant_id = selected.tenant_id
                AND transition.shadow_period_id = selected.shadow_period_id
                AND transition.occurred_at <= selected.scheduled_for
              ORDER BY transition.occurred_at DESC
              LIMIT 1
           ), 'not_started') AS scheduled_state
      FROM selected
  )
  SELECT COALESCE((
    SELECT jsonb_build_object(
      'run_date', p_run_date,
      'tenant_id', state_at_schedule.tenant_id,
      'shadow_period_id', state_at_schedule.shadow_period_id,
      'scheduled_for', state_at_schedule.scheduled_for,
      'expected', state_at_schedule.scheduled_state = 'running'
                  AND p_run_date >= DATE '2026-10-01'
                  AND p_run_date < DATE '2026-11-01',
      'scheduled_state', state_at_schedule.scheduled_state,
      'status', CASE
        WHEN state_at_schedule.scheduled_state <> 'running'
          OR p_run_date < DATE '2026-10-01'
          OR p_run_date >= DATE '2026-11-01' THEN 'not_expected'
        WHEN daily.tenant_id IS NULL THEN 'missing'
        ELSE 'complete'
      END,
      'daily_run', CASE WHEN daily.tenant_id IS NULL THEN NULL ELSE jsonb_build_object(
        'deployed_sha', daily.deployed_sha,
        'started_at', daily.started_at,
        'completed_at', daily.completed_at,
        'api_expected_requests', daily.api_expected_requests,
        'api_completed_requests', daily.api_completed_requests,
        'mcp_expected_requests', daily.mcp_expected_requests,
        'mcp_completed_requests', daily.mcp_completed_requests,
        'api_reconciliation_run_id', daily.api_reconciliation_run_id,
        'mcp_reconciliation_run_id', daily.mcp_reconciliation_run_id,
        'observation_id', daily.observation_id,
        'run_reference', daily.run_reference,
        'evidence', daily.evidence,
        'api_reconciliation', (
          SELECT jsonb_build_object(
            'status', reconciliation.status,
            'raw_request_count', reconciliation.raw_request_count,
            'raw_billable_units', reconciliation.raw_billable_units,
            'raw_limiter_decision_count', reconciliation.raw_limiter_decision_count,
            'rollup_request_count', reconciliation.rollup_request_count,
            'rollup_billable_units', reconciliation.rollup_billable_units,
            'gateway_request_count', reconciliation.gateway_request_count,
            'limiter_decision_count', reconciliation.limiter_decision_count,
            'meter_persistence_failures', reconciliation.meter_persistence_failures,
            'discrepancy', reconciliation.discrepancy,
            'period_start', reconciliation.period_start,
            'period_end', reconciliation.period_end
          ) FROM api_usage_reconciliation_runs reconciliation
           WHERE reconciliation.tenant_id = daily.tenant_id
             AND reconciliation.id = daily.api_reconciliation_run_id
        ),
        'mcp_reconciliation', (
          SELECT jsonb_build_object(
            'status', reconciliation.status,
            'transport_request_count', reconciliation.transport_request_count,
            'raw_meter_request_count', reconciliation.raw_meter_request_count,
            'raw_billable_units', reconciliation.raw_billable_units,
            'rollup_request_count', reconciliation.rollup_request_count,
            'rollup_billable_units', reconciliation.rollup_billable_units,
            'missing_meter_count', reconciliation.missing_meter_count,
            'unexpected_meter_count', reconciliation.unexpected_meter_count,
            'meter_persistence_failures', reconciliation.meter_persistence_failures,
            'discrepancy', reconciliation.discrepancy,
            'period_start', reconciliation.period_start,
            'period_end', reconciliation.period_end
          ) FROM mcp_usage_reconciliation_runs reconciliation
           WHERE reconciliation.tenant_id = daily.tenant_id
             AND reconciliation.id = daily.mcp_reconciliation_run_id
        ),
        'observation', (
          SELECT jsonb_build_object(
            'catalog_resolution', observation.catalog_resolution,
            'entity_capacity_result', observation.entity_capacity_result,
            'agent_capacity_result', observation.agent_capacity_result,
            'execution_limit_result', observation.execution_limit_result,
            'api_units', observation.api_units,
            'mcp_units', observation.mcp_units,
            'api_unit_result', observation.api_unit_result,
            'mcp_unit_result', observation.mcp_unit_result,
            'api_evidence_complete', observation.api_evidence_complete,
            'mcp_evidence_complete', observation.mcp_evidence_complete,
            'divergence_codes', observation.divergence_codes,
            'enforcement_applied', observation.enforcement_applied,
            'observed_at', observation.observed_at
          ) FROM commercial_shadow_observations observation
           WHERE observation.tenant_id = daily.tenant_id
             AND observation.id = daily.observation_id
        )
      ) END,
      'scheduler', COALESCE((
        SELECT jsonb_build_object(
          'revision', heartbeat.scheduler_revision,
          'deployed_sha', heartbeat.deployed_sha,
          'state', heartbeat.state,
          'checked_at', heartbeat.checked_at,
          'next_run_at', heartbeat.next_run_at,
          'fresh', heartbeat.checked_at >= clock_timestamp() - interval '15 minutes'
                   AND heartbeat.next_run_at > clock_timestamp()
                   AND heartbeat.next_run_at <= clock_timestamp() + interval '26 hours'
        ) FROM commercial_shadow_scheduler_heartbeats heartbeat
         WHERE heartbeat.environment = 'live'
      ), 'null'::jsonb),
      'zero_billing_state', NOT (
        EXISTS (SELECT 1 FROM commercial_billing_account_tenants WHERE tenant_id = state_at_schedule.tenant_id)
        OR EXISTS (
          SELECT 1 FROM tenant_commercial_entitlements entitlement
           WHERE entitlement.tenant_id = state_at_schedule.tenant_id
             AND (entitlement.billing_account_id IS NOT NULL OR entitlement.price_revision_id IS NOT NULL)
        )
        OR EXISTS (SELECT 1 FROM commercial_stripe_subscriptions WHERE tenant_id = state_at_schedule.tenant_id)
        OR EXISTS (SELECT 1 FROM commercial_stripe_events WHERE tenant_id = state_at_schedule.tenant_id)
        OR EXISTS (SELECT 1 FROM commercial_charge_facts WHERE tenant_id = state_at_schedule.tenant_id)
        OR EXISTS (SELECT 1 FROM x402_payment_operations WHERE tenant_id = state_at_schedule.tenant_id)
        OR EXISTS (SELECT 1 FROM commercial_provider_commands WHERE tenant_id = state_at_schedule.tenant_id)
        OR EXISTS (
          SELECT 1 FROM api_billing_periods period
           WHERE period.tenant_id = state_at_schedule.tenant_id
             AND (period.mode = 'billable_closed' OR period.chargeable_units <> 0)
        )
        OR EXISTS (SELECT 1 FROM api_billing_adjustments WHERE tenant_id = state_at_schedule.tenant_id)
      )
    )
      FROM state_at_schedule
      LEFT JOIN commercial_shadow_daily_runs daily
        ON daily.tenant_id = state_at_schedule.tenant_id
       AND daily.shadow_period_id = state_at_schedule.shadow_period_id
       AND daily.run_date = p_run_date
  ), jsonb_build_object(
    'run_date', p_run_date, 'expected', FALSE,
    'scheduled_state', 'not_started', 'status', 'not_expected'
  ));
$$;

REVOKE ALL ON commercial_shadow_daily_runs FROM PUBLIC;
REVOKE ALL ON FUNCTION write_commercial_shadow_scheduler_heartbeat(
  TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_internal_commercial_shadow_daily_run(
  TEXT,TEXT,DATE,TIMESTAMPTZ,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,
  INTEGER,INTEGER,INTEGER,INTEGER,TEXT,TEXT,TEXT,TEXT,JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION report_internal_commercial_shadow_day(DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION require_commercial_shadow_daily_runs_for_completion() FROM PUBLIC;

DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'brain_app', 'brain_privileged', 'brain_wiki_reader', 'brain_mcp_reader',
    'brain_raw_worker', 'brain_canonical_projector', 'brain_ledger_projector',
    'brain_execution_worker', 'brain_audit_verifier', 'brain_audit_publisher',
    'brain_resolver', 'brain_tenant_deletion', 'brain_surface_gateway',
    'brain_surface_audit_writer', 'brain_auth', 'brain_auth_audit_writer'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON commercial_shadow_daily_runs FROM %I', role_name);
      EXECUTE format(
        'REVOKE ALL ON FUNCTION write_commercial_shadow_scheduler_heartbeat(TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT) FROM %I',
        role_name
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION record_internal_commercial_shadow_daily_run(TEXT,TEXT,DATE,TIMESTAMPTZ,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,INTEGER,INTEGER,INTEGER,INTEGER,TEXT,TEXT,TEXT,TEXT,JSONB) FROM %I',
        role_name
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION report_internal_commercial_shadow_day(DATE) FROM %I',
        role_name
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION require_commercial_shadow_daily_runs_for_completion() FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_privileged') THEN
    GRANT SELECT ON commercial_shadow_daily_runs TO brain_privileged;
    GRANT EXECUTE ON FUNCTION write_commercial_shadow_scheduler_heartbeat(
      TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT
    ) TO brain_privileged;
    GRANT EXECUTE ON FUNCTION record_internal_commercial_shadow_daily_run(
      TEXT,TEXT,DATE,TIMESTAMPTZ,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,
      INTEGER,INTEGER,INTEGER,INTEGER,TEXT,TEXT,TEXT,TEXT,JSONB
    ) TO brain_privileged;
    GRANT EXECUTE ON FUNCTION report_internal_commercial_shadow_day(DATE)
      TO brain_privileged;
  END IF;
END;
$$;

COMMENT ON TABLE commercial_shadow_daily_runs IS
  'Immutable proof that one scheduled internal commercial shadow workload and both independent reconciliations completed.';
COMMENT ON FUNCTION report_internal_commercial_shadow_day(DATE) IS
  'Side-effect-free scheduled report and missing-run heartbeat contract for one UTC day.';

COMMIT;
