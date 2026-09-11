-- RFC 0011 Phase 3: guarded lifecycle for the one internal commercial shadow.
-- The only start primitive provisions the dedicated tenant and records the
-- database start instant in one transaction. Protected workflows call the
-- SECURITY DEFINER functions; runtime roles receive no mutation grants.

BEGIN;

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_data_profile_check;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_data_profile_check CHECK (
    data_profile IS NULL
    OR data_profile IN (
      'synthetic_brightline_v1', 'customer', 'internal_commercial_shadow_v1'
    )
  );

ALTER TABLE commercial_shadow_periods
  ADD COLUMN state TEXT,
  ADD COLUMN paused_at TIMESTAMPTZ,
  ADD COLUMN stopped_at TIMESTAMPTZ,
  ADD COLUMN stopped_by TEXT,
  ADD COLUMN stop_reason TEXT,
  ADD COLUMN completed_by TEXT;

UPDATE commercial_shadow_periods
   SET state = CASE WHEN completed_at IS NULL THEN 'running' ELSE 'completed' END,
       completed_by = CASE WHEN completed_at IS NULL THEN NULL ELSE 'pre_phase3_migration' END
 WHERE state IS NULL;

ALTER TABLE commercial_shadow_periods
  ALTER COLUMN state SET DEFAULT 'running',
  ALTER COLUMN state SET NOT NULL,
  ADD CONSTRAINT commercial_shadow_period_state_value_check
    CHECK (state IN ('running', 'paused', 'stopped', 'completed')),
  ADD CONSTRAINT commercial_shadow_period_state_check CHECK (
    (state = 'running' AND completed_at IS NULL AND stopped_at IS NULL)
    OR (state = 'paused' AND paused_at IS NOT NULL AND completed_at IS NULL AND stopped_at IS NULL)
    OR (state = 'stopped' AND stopped_at IS NOT NULL AND stopped_by IS NOT NULL
        AND stop_reason IS NOT NULL AND completed_at IS NULL)
    OR (state = 'completed' AND completed_at IS NOT NULL AND completed_by IS NOT NULL
        AND stopped_at IS NULL)
  );

CREATE TABLE commercial_shadow_scheduler_heartbeats (
  environment           TEXT        PRIMARY KEY CHECK (environment = 'live'),
  scheduler_revision    TEXT        NOT NULL CHECK (
    scheduler_revision = 'commercial_shadow_daily_v1'
  ),
  deployed_sha          TEXT        NOT NULL CHECK (deployed_sha ~ '^[0-9a-f]{40}$'),
  state                 TEXT        NOT NULL CHECK (state IN ('ready', 'unhealthy')),
  checked_at            TIMESTAMPTZ NOT NULL,
  next_run_at           TIMESTAMPTZ NOT NULL,
  run_reference         TEXT        NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (next_run_at > checked_at AND next_run_at <= checked_at + interval '26 hours')
);

CREATE TABLE commercial_shadow_state_transitions (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  shadow_period_id      TEXT        NOT NULL REFERENCES commercial_shadow_periods(id) ON DELETE RESTRICT,
  action                TEXT        NOT NULL CHECK (action IN ('start', 'resume', 'pause', 'stop', 'complete')),
  from_state            TEXT CHECK (from_state IN ('running', 'paused')),
  to_state              TEXT        NOT NULL CHECK (to_state IN ('running', 'paused', 'stopped', 'completed')),
  approved_sha          TEXT        NOT NULL CHECK (approved_sha ~ '^[0-9a-f]{40}$'),
  actor                 TEXT        NOT NULL,
  reason                TEXT        NOT NULL CHECK (
    char_length(reason) BETWEEN 10 AND 240 AND reason !~ E'[\r\n]'
  ),
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id)
);

CREATE OR REPLACE FUNCTION reject_commercial_shadow_transition_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000',
    MESSAGE = 'commercial shadow transitions are immutable';
END;
$$;

CREATE TRIGGER commercial_shadow_transitions_immutable_row
BEFORE UPDATE OR DELETE ON commercial_shadow_state_transitions
FOR EACH ROW EXECUTE FUNCTION reject_commercial_shadow_transition_mutation();
CREATE TRIGGER commercial_shadow_transitions_immutable_truncate
BEFORE TRUNCATE ON commercial_shadow_state_transitions
FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_shadow_transition_mutation();

ALTER TABLE commercial_shadow_state_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_shadow_state_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY commercial_shadow_state_transitions_tenant_read
  ON commercial_shadow_state_transitions FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE OR REPLACE FUNCTION assert_internal_commercial_shadow_zero_billing(p_tenant_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM commercial_billing_account_tenants WHERE tenant_id = p_tenant_id)
     OR EXISTS (
       SELECT 1 FROM tenant_commercial_entitlements
        WHERE tenant_id = p_tenant_id
          AND (billing_account_id IS NOT NULL OR price_revision_id IS NOT NULL)
     )
     OR EXISTS (SELECT 1 FROM commercial_stripe_subscriptions WHERE tenant_id = p_tenant_id)
     OR EXISTS (SELECT 1 FROM commercial_stripe_events WHERE tenant_id = p_tenant_id)
     OR EXISTS (SELECT 1 FROM commercial_charge_facts WHERE tenant_id = p_tenant_id)
     OR EXISTS (SELECT 1 FROM x402_payment_operations WHERE tenant_id = p_tenant_id)
     OR EXISTS (SELECT 1 FROM commercial_provider_commands WHERE tenant_id = p_tenant_id)
     OR EXISTS (
       SELECT 1 FROM api_billing_periods
        WHERE tenant_id = p_tenant_id
          AND (mode = 'billable_closed' OR chargeable_units <> 0)
     )
     OR EXISTS (SELECT 1 FROM api_billing_adjustments WHERE tenant_id = p_tenant_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'internal commercial shadow tenant has billing state';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION start_internal_commercial_shadow(
  p_tenant_id TEXT,
  p_member_id TEXT,
  p_policy_id TEXT,
  p_policy_content JSONB,
  p_policy_content_hash BYTEA,
  p_agent_id TEXT,
  p_agent_scope_hash BYTEA,
  p_agent_key_id TEXT,
  p_agent_key_hash TEXT,
  p_agent_key_last4 TEXT,
  p_api_key_id TEXT,
  p_api_key_hash TEXT,
  p_api_key_last4 TEXT,
  p_entity_id TEXT,
  p_shadow_period_id TEXT,
  p_transition_id TEXT,
  p_approved_sha TEXT,
  p_actor TEXT,
  p_reason TEXT
)
RETURNS TABLE (
  tenant_id TEXT,
  shadow_period_id TEXT,
  started_at TIMESTAMPTZ,
  agent_id TEXT,
  agent_key_id TEXT,
  api_key_id TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_started_at TIMESTAMPTZ;
  v_entitlement_version INTEGER;
  v_api_units BIGINT;
  v_mcp_units BIGINT;
BEGIN
  IF p_tenant_id !~ '^tnt_[0-9A-HJKMNP-TV-Z]{26}$'
     OR p_tenant_id IN (
       'tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ',
       'tnt_00000000010000000000000000',
       'tnt_01KYAT7A1QRKHTYW9H4RAR2SEX',
       'tnt_01M1GTBQN8R8PB6X6PN73YB6NP'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'shadow tenant id is invalid or protected';
  END IF;
  IF p_member_id !~ '^user_[0-9A-HJKMNP-TV-Z]{26}$'
     OR p_policy_id !~ '^pol_[0-9A-HJKMNP-TV-Z]{26}$'
     OR p_agent_id !~ '^agent_[0-9A-HJKMNP-TV-Z]{26}$'
     OR p_agent_key_id !~ '^agkey_[0-9A-HJKMNP-TV-Z]{26}$'
     OR p_api_key_id !~ '^akey_[0-9A-HJKMNP-TV-Z]{26}$'
     OR p_entity_id !~ '^rme_[0-9A-HJKMNP-TV-Z]{26}$'
     OR p_shadow_period_id !~ '^csp_[0-9A-HJKMNP-TV-Z]{26}$'
     OR p_transition_id !~ '^cst_[0-9A-HJKMNP-TV-Z]{26}$'
     OR p_policy_content IS NULL
     OR jsonb_typeof(p_policy_content) <> 'object'
     OR octet_length(p_policy_content_hash) <> 32
     OR octet_length(p_agent_scope_hash) <> 32
     OR p_agent_key_hash !~ '^[0-9a-f]{64}$'
     OR p_api_key_hash !~ '^[0-9a-f]{64}$'
     OR p_agent_key_last4 !~ '^[A-Za-z0-9_-]{4}$'
     OR p_api_key_last4 !~ '^[A-Za-z0-9_-]{4}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid shadow provisioning material';
  END IF;
  IF p_approved_sha !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid approved sha';
  END IF;
  IF p_actor IS NULL OR char_length(p_actor) NOT BETWEEN 1 AND 200
     OR p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 10 AND 240
     OR p_reason ~ E'[\r\n]' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid operator evidence';
  END IF;
  IF EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id)
     OR EXISTS (
       SELECT 1 FROM commercial_shadow_periods
        WHERE state IN ('running', 'paused')
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505',
      MESSAGE = 'shadow tenant or active shadow period already exists';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM commercial_shadow_scheduler_heartbeats
     WHERE environment = 'live'
       AND scheduler_revision = 'commercial_shadow_daily_v1'
       AND deployed_sha = p_approved_sha
       AND state = 'ready'
       AND checked_at >= clock_timestamp() - interval '15 minutes'
       AND next_run_at > clock_timestamp()
       AND next_run_at <= clock_timestamp() + interval '26 hours'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'commercial shadow scheduler is not healthy for approved sha';
  END IF;

  SELECT included_api_units, included_mcp_units
    INTO v_api_units, v_mcp_units
    FROM api_commercial_tier_catalog
   WHERE id = 'robotmoney_growth_v1'
     AND public = TRUE
     AND retired_at IS NULL
     AND external_api_access = 'included'
     AND external_mcp_access = 'included'
     AND included_api_units = 25000
     AND included_mcp_units = 2500;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'approved Growth catalog revision is unavailable or drifted';
  END IF;

  INSERT INTO tenants (
    id, kind, sandbox, created_via, audit_anchor_mode, provisioning_state,
    data_profile, access_stage, business_name, do_not_delete
  ) VALUES (
    p_tenant_id, 'production', FALSE, 'admin', 'db_only', NULL,
    'internal_commercial_shadow_v1', 'production',
    'RobotMoney Internal Commercial Shadow 2026-10', TRUE
  );
  INSERT INTO users (id, tenant_id, email, role, status)
  VALUES (
    p_member_id, p_tenant_id,
    'bootstrap+' || p_tenant_id || '@brain.invalid', 'owner', 'active'
  );
  INSERT INTO members (
    tenant_id, id, email, display_name, role, status, active,
    approval_domains, per_item_limit_cents
  ) VALUES (
    p_tenant_id, p_member_id,
    'bootstrap+' || p_tenant_id || '@brain.invalid', 'Bootstrap Admin',
    'admin', 'active', TRUE,
    ARRAY['ap','ar','treasury','payroll','reconciliation']::TEXT[],
    9223372036854775807
  );
  INSERT INTO policies (
    id, tenant_id, version, content, content_hash, quorum_required,
    state, created_by, activated_at
  ) VALUES (
    p_policy_id, p_tenant_id, 1, p_policy_content, p_policy_content_hash,
    1, 'active', p_member_id, clock_timestamp()
  );
  INSERT INTO agents (
    id, tenant_id, kind, role, display_name, scope_hash, onchain_address,
    state, registered_at, created_at, contribution_count, quarantine_threshold
  ) VALUES (
    p_agent_id, p_tenant_id, 'internal', 'payment', 'BFF Service Agent',
    p_agent_scope_hash, '0x0000000000000000000000000000000000000000',
    'active', clock_timestamp(), clock_timestamp(), 0, 100
  );

  INSERT INTO commercial_billing_exclusions (
    tenant_id, exclusion_kind, reason, created_by
  ) VALUES (
    p_tenant_id, 'internal_commercial_shadow', p_reason, p_actor
  );
  INSERT INTO tenant_commercial_entitlements (
    tenant_id, catalog_revision_id, price_revision_id, billing_account_id,
    lifecycle_status, access_status, source, version, effective_at
  ) VALUES (
    p_tenant_id, 'robotmoney_growth_v1', NULL, NULL,
    'active', 'active', 'internal_commercial_shadow_operator', 1, clock_timestamp()
  ) RETURNING version INTO v_entitlement_version;
  UPDATE tenant_api_entitlements AS entitlement
     SET tier_id = 'standard_v1', status = 'active', version = version + 1,
         effective_at = clock_timestamp(), updated_at = clock_timestamp(),
         source = 'internal_commercial_shadow_operator'
   WHERE entitlement.tenant_id = p_tenant_id AND entitlement.environment = 'live';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'live API entitlement missing';
  END IF;
  INSERT INTO robotmoney_entities (
    id, tenant_id, display_name, legal_name, state,
    commercial_cap_revision_id, created_by
  ) VALUES (
    p_entity_id, p_tenant_id, 'RobotMoney Internal Shadow Entity', NULL,
    'active', 'robotmoney_growth_v1', p_actor
  );

  INSERT INTO agent_api_keys (
    id, tenant_id, agent_id, profile, environment, scopes, hashed_secret,
    key_prefix, key_last4, name, expires_at
  ) VALUES (
    p_agent_key_id, p_tenant_id, p_agent_id, 'bff_service_v1', 'live',
    ARRAY[
      'ledger:read','wiki:read','raw:read','raw:write','policy:read',
      'execution:read','execution:propose','payment_intent:propose','audit:read'
    ]::TEXT[], p_agent_key_hash, 'brain_ak_live_', p_agent_key_last4,
    'Internal commercial shadow BFF', clock_timestamp() + interval '90 days'
  );
  INSERT INTO api_keys (
    id, tenant_id, name, environment, scopes, key_prefix, key_last4,
    hashed_secret, expires_at
  ) VALUES (
    p_api_key_id, p_tenant_id, 'Internal commercial shadow API', 'live',
    ARRAY['ledger:read','audit:read','governance:read']::TEXT[],
    'brain_sk_live_', p_api_key_last4, p_api_key_hash,
    clock_timestamp() + interval '90 days'
  );

  PERFORM assert_internal_commercial_shadow_zero_billing(p_tenant_id);
  IF NOT EXISTS (
    SELECT 1 FROM commercial_billing_exclusions exclusion
     WHERE exclusion.tenant_id = p_tenant_id
       AND exclusion.exclusion_kind = 'internal_commercial_shadow'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'billing exclusion missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tenants tenant
     WHERE tenant.id = p_tenant_id
       AND tenant.kind = 'production'
       AND tenant.sandbox = FALSE
       AND tenant.data_profile = 'internal_commercial_shadow_v1'
       AND tenant.access_stage = 'production'
       AND tenant.do_not_delete = TRUE
  ) OR NOT EXISTS (
    SELECT 1 FROM tenant_commercial_entitlements entitlement
     WHERE entitlement.tenant_id = p_tenant_id
       AND entitlement.catalog_revision_id = 'robotmoney_growth_v1'
       AND entitlement.lifecycle_status = 'active'
       AND entitlement.access_status = 'active'
       AND entitlement.billing_account_id IS NULL
       AND entitlement.price_revision_id IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM agent_api_keys key
     WHERE key.id = p_agent_key_id AND key.tenant_id = p_tenant_id
       AND key.agent_id = p_agent_id AND key.profile = 'bff_service_v1'
       AND key.environment = 'live'
       AND key.scopes = ARRAY[
         'ledger:read','wiki:read','raw:read','raw:write','policy:read',
         'execution:read','execution:propose','payment_intent:propose','audit:read'
       ]::TEXT[]
       AND key.revoked_at IS NULL AND key.expires_at > clock_timestamp()
  ) OR NOT EXISTS (
    SELECT 1 FROM api_keys key
     WHERE key.id = p_api_key_id AND key.tenant_id = p_tenant_id
       AND key.environment = 'live'
       AND key.scopes = ARRAY['ledger:read','audit:read','governance:read']::TEXT[]
       AND key.revoked_at IS NULL AND key.expires_at > clock_timestamp()
  ) OR NOT EXISTS (
    SELECT 1 FROM commercial_shadow_scheduler_heartbeats
     WHERE environment = 'live' AND deployed_sha = p_approved_sha
       AND state = 'ready'
       AND checked_at >= clock_timestamp() - interval '15 minutes'
       AND next_run_at > clock_timestamp()
       AND next_run_at <= clock_timestamp() + interval '26 hours'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'commercial shadow start postconditions failed';
  END IF;

  v_started_at := clock_timestamp();
  INSERT INTO commercial_shadow_periods (id, started_at, minimum_days, state)
  VALUES (p_shadow_period_id, v_started_at, 30, 'running');
  INSERT INTO commercial_shadow_contracts (
    tenant_id, shadow_period_id, catalog_revision_id, entitlement_version,
    environment, api_unit_allowance, mcp_unit_allowance, created_by
  ) VALUES (
    p_tenant_id, p_shadow_period_id, 'robotmoney_growth_v1',
    v_entitlement_version, 'live', v_api_units, v_mcp_units, p_actor
  );
  INSERT INTO commercial_shadow_state_transitions (
    id, tenant_id, shadow_period_id, action, from_state, to_state,
    approved_sha, actor, reason, occurred_at
  ) VALUES (
    p_transition_id, p_tenant_id, p_shadow_period_id, 'start', NULL,
    'running', p_approved_sha, p_actor, p_reason, v_started_at
  );

  RETURN QUERY SELECT p_tenant_id, p_shadow_period_id, v_started_at,
    p_agent_id, p_agent_key_id, p_api_key_id;
END;
$$;

CREATE OR REPLACE FUNCTION transition_internal_commercial_shadow(
  p_action TEXT,
  p_transition_id TEXT,
  p_approved_sha TEXT,
  p_actor TEXT,
  p_reason TEXT
)
RETURNS TABLE (tenant_id TEXT, shadow_period_id TEXT, state TEXT, started_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant_id TEXT;
  v_period_id TEXT;
  v_state TEXT;
  v_started_at TIMESTAMPTZ;
  v_distinct_days INTEGER;
BEGIN
  IF p_action NOT IN ('resume', 'pause', 'stop', 'complete') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid shadow transition';
  END IF;
  IF p_approved_sha !~ '^[0-9a-f]{40}$'
     OR p_actor IS NULL OR char_length(p_actor) NOT BETWEEN 1 AND 200
     OR p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 10 AND 240
     OR p_reason ~ E'[\r\n]' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid operator evidence';
  END IF;

  SELECT contract.tenant_id, period.id, period.state, period.started_at
    INTO v_tenant_id, v_period_id, v_state, v_started_at
    FROM commercial_shadow_contracts contract
    JOIN commercial_shadow_periods period ON period.id = contract.shadow_period_id
    JOIN tenants tenant ON tenant.id = contract.tenant_id
   WHERE tenant.data_profile = 'internal_commercial_shadow_v1'
     AND tenant.access_stage = 'production'
     AND tenant.kind = 'production'
     AND contract.catalog_revision_id = 'robotmoney_growth_v1'
     AND contract.environment = 'live'
   ORDER BY period.created_at DESC
   LIMIT 1
   FOR UPDATE OF period;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'shadow contract not found';
  END IF;
  IF v_tenant_id IN (
    'tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ',
    'tnt_00000000010000000000000000',
    'tnt_01KYAT7A1QRKHTYW9H4RAR2SEX',
    'tnt_01M1GTBQN8R8PB6X6PN73YB6NP'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'protected tenant rejected';
  END IF;
  IF p_action = 'resume' THEN
    PERFORM assert_internal_commercial_shadow_zero_billing(v_tenant_id);
    IF v_state <> 'paused' THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'only a paused shadow can resume';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM commercial_shadow_scheduler_heartbeats scheduler
       WHERE scheduler.environment = 'live'
         AND scheduler.scheduler_revision = 'commercial_shadow_daily_v1'
         AND scheduler.deployed_sha = p_approved_sha
         AND scheduler.state = 'ready'
         AND scheduler.checked_at >= clock_timestamp() - interval '15 minutes'
         AND scheduler.next_run_at > clock_timestamp()
         AND scheduler.next_run_at <= clock_timestamp() + interval '26 hours'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'scheduler is not healthy';
    END IF;
    UPDATE commercial_shadow_periods SET state = 'running', paused_at = NULL
     WHERE id = v_period_id;
  ELSIF p_action = 'pause' THEN
    IF v_state <> 'running' THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'only a running shadow can pause';
    END IF;
    UPDATE commercial_shadow_periods SET state = 'paused', paused_at = clock_timestamp()
     WHERE id = v_period_id;
  ELSIF p_action = 'stop' THEN
    IF v_state NOT IN ('running', 'paused') THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'shadow is already terminal';
    END IF;
    UPDATE commercial_shadow_periods
       SET state = 'stopped', paused_at = NULL, stopped_at = clock_timestamp(),
           stopped_by = p_actor, stop_reason = p_reason
     WHERE id = v_period_id;
    UPDATE agent_api_keys AS key SET revoked_at = clock_timestamp()
     WHERE key.tenant_id = v_tenant_id AND key.revoked_at IS NULL;
    UPDATE api_keys AS key SET revoked_at = clock_timestamp()
     WHERE key.tenant_id = v_tenant_id AND key.revoked_at IS NULL;
  ELSE
    PERFORM assert_internal_commercial_shadow_zero_billing(v_tenant_id);
    IF v_state <> 'running' OR clock_timestamp() < v_started_at + interval '30 days' THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'shadow must be running for at least 30 days before completion';
    END IF;
    SELECT count(DISTINCT (observed_at AT TIME ZONE 'UTC')::date)
      INTO v_distinct_days
      FROM commercial_shadow_observations observation
     WHERE observation.tenant_id = v_tenant_id
       AND observation.shadow_period_id = v_period_id
       AND observation.observed_at >= v_started_at
       AND observation.observed_at <= clock_timestamp()
       AND observation.api_evidence_complete = TRUE
       AND observation.mcp_evidence_complete = TRUE
       AND observation.api_reconciliation_run_id IS NOT NULL
       AND observation.mcp_reconciliation_run_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM api_usage_reconciliation_runs api_run
          WHERE api_run.tenant_id = observation.tenant_id
            AND api_run.id = observation.api_reconciliation_run_id
            AND api_run.status = 'matched'
            AND api_run.meter_persistence_failures = 0
       )
       AND EXISTS (
         SELECT 1 FROM mcp_usage_reconciliation_runs mcp_run
          WHERE mcp_run.tenant_id = observation.tenant_id
            AND mcp_run.id = observation.mcp_reconciliation_run_id
            AND mcp_run.status = 'matched'
            AND mcp_run.missing_meter_count = 0
            AND mcp_run.unexpected_meter_count = 0
            AND mcp_run.meter_persistence_failures = 0
       )
       AND observation.api_unit_result <> 'unresolved'
       AND observation.mcp_unit_result <> 'unresolved'
       AND observation.entity_capacity_result <> 'unresolved'
       AND observation.agent_capacity_result <> 'unresolved'
       AND observation.execution_limit_result <> 'unresolved'
       AND observation.enforcement_applied = FALSE;
    IF v_distinct_days < 30 OR EXISTS (
      SELECT 1 FROM commercial_shadow_observations observation
       WHERE observation.tenant_id = v_tenant_id
         AND observation.shadow_period_id = v_period_id
         AND (observation.observed_at < v_started_at
              OR observation.observed_at > clock_timestamp()
              OR observation.api_evidence_complete = FALSE
              OR observation.mcp_evidence_complete = FALSE
              OR observation.api_reconciliation_run_id IS NULL
              OR observation.mcp_reconciliation_run_id IS NULL
              OR observation.api_unit_result = 'unresolved'
              OR observation.mcp_unit_result = 'unresolved'
              OR observation.entity_capacity_result = 'unresolved'
              OR observation.agent_capacity_result = 'unresolved'
              OR observation.execution_limit_result = 'unresolved'
              OR observation.enforcement_applied = TRUE
              OR NOT EXISTS (
                SELECT 1 FROM api_usage_reconciliation_runs api_run
                 WHERE api_run.tenant_id = observation.tenant_id
                   AND api_run.id = observation.api_reconciliation_run_id
                   AND api_run.status = 'matched'
                   AND api_run.meter_persistence_failures = 0
              )
              OR NOT EXISTS (
                SELECT 1 FROM mcp_usage_reconciliation_runs mcp_run
                 WHERE mcp_run.tenant_id = observation.tenant_id
                   AND mcp_run.id = observation.mcp_reconciliation_run_id
                   AND mcp_run.status = 'matched'
                   AND mcp_run.missing_meter_count = 0
                   AND mcp_run.unexpected_meter_count = 0
                   AND mcp_run.meter_persistence_failures = 0
              )
              OR 'api_reconciliation_mismatch' = ANY(observation.divergence_codes)
              OR 'mcp_reconciliation_mismatch' = ANY(observation.divergence_codes))
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = '30 complete daily observations are required';
    END IF;
    UPDATE commercial_shadow_periods
       SET state = 'completed', completed_at = clock_timestamp(), completed_by = p_actor
     WHERE id = v_period_id;
    UPDATE agent_api_keys AS key SET revoked_at = clock_timestamp()
     WHERE key.tenant_id = v_tenant_id AND key.revoked_at IS NULL;
    UPDATE api_keys AS key SET revoked_at = clock_timestamp()
     WHERE key.tenant_id = v_tenant_id AND key.revoked_at IS NULL;
  END IF;

  INSERT INTO commercial_shadow_state_transitions (
    id, tenant_id, shadow_period_id, action, from_state, to_state,
    approved_sha, actor, reason
  ) VALUES (
    p_transition_id, v_tenant_id, v_period_id, p_action, v_state,
    CASE p_action
      WHEN 'resume' THEN 'running'
      WHEN 'pause' THEN 'paused'
      WHEN 'stop' THEN 'stopped'
      ELSE 'completed'
    END,
    p_approved_sha, p_actor, p_reason
  );
  RETURN QUERY SELECT v_tenant_id, v_period_id,
    CASE p_action
      WHEN 'resume' THEN 'running'
      WHEN 'pause' THEN 'paused'
      WHEN 'stop' THEN 'stopped'
      ELSE 'completed'
    END,
    v_started_at;
END;
$$;

CREATE OR REPLACE FUNCTION inspect_internal_commercial_shadow()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH selected AS (
    SELECT contract.tenant_id, contract.shadow_period_id,
           contract.catalog_revision_id, contract.entitlement_version,
           contract.environment, contract.api_unit_allowance,
           contract.mcp_unit_allowance, period.state, period.started_at,
           period.paused_at, period.stopped_at, period.completed_at,
           tenant.kind, tenant.provisioning_state, tenant.data_profile,
           tenant.access_stage
      FROM commercial_shadow_contracts contract
      JOIN commercial_shadow_periods period ON period.id = contract.shadow_period_id
      JOIN tenants tenant ON tenant.id = contract.tenant_id
     WHERE tenant.data_profile = 'internal_commercial_shadow_v1'
     ORDER BY period.created_at DESC
     LIMIT 1
  )
  SELECT COALESCE((
    SELECT jsonb_build_object(
      'tenant_id', selected.tenant_id,
      'shadow_period_id', selected.shadow_period_id,
      'state', selected.state,
      'started_at', selected.started_at,
      'paused_at', selected.paused_at,
      'stopped_at', selected.stopped_at,
      'completed_at', selected.completed_at,
      'provenance', jsonb_build_object(
        'kind', selected.kind,
        'provisioning_state', selected.provisioning_state,
        'data_profile', selected.data_profile,
        'access_stage', selected.access_stage
      ),
      'growth_entitlement_valid', EXISTS (
        SELECT 1 FROM tenant_commercial_entitlements entitlement
         WHERE entitlement.tenant_id = selected.tenant_id
           AND entitlement.catalog_revision_id = 'robotmoney_growth_v1'
           AND entitlement.version = selected.entitlement_version
           AND entitlement.lifecycle_status = 'active'
           AND entitlement.access_status = 'active'
           AND entitlement.billing_account_id IS NULL
           AND entitlement.price_revision_id IS NULL
      ),
      'api_rate_entitlement_valid', EXISTS (
        SELECT 1 FROM tenant_api_entitlements entitlement
         WHERE entitlement.tenant_id = selected.tenant_id
           AND entitlement.environment = 'live'
           AND entitlement.tier_id = 'standard_v1'
           AND entitlement.status = 'active'
      ),
      'contract', jsonb_build_object(
        'catalog_revision_id', selected.catalog_revision_id,
        'environment', selected.environment,
        'api_unit_allowance', selected.api_unit_allowance,
        'mcp_unit_allowance', selected.mcp_unit_allowance
      ),
      'billing_exclusion_present', EXISTS (
        SELECT 1 FROM commercial_billing_exclusions exclusion
         WHERE exclusion.tenant_id = selected.tenant_id
           AND exclusion.exclusion_kind = 'internal_commercial_shadow'
      ),
      'bff_agent_key_active', EXISTS (
        SELECT 1 FROM agent_api_keys key
         WHERE key.tenant_id = selected.tenant_id
           AND key.profile = 'bff_service_v1' AND key.environment = 'live'
           AND key.scopes = ARRAY[
             'ledger:read','wiki:read','raw:read','raw:write','policy:read',
             'execution:read','execution:propose','payment_intent:propose','audit:read'
           ]::TEXT[]
           AND key.revoked_at IS NULL AND key.expires_at > clock_timestamp()
      ),
      'commercial_api_key_active', EXISTS (
        SELECT 1 FROM api_keys key
         WHERE key.tenant_id = selected.tenant_id AND key.environment = 'live'
           AND key.scopes = ARRAY['ledger:read','audit:read','governance:read']::TEXT[]
           AND key.revoked_at IS NULL
           AND (key.expires_at IS NULL OR key.expires_at > clock_timestamp())
      ),
      'zero_billing_state', NOT (
        EXISTS (SELECT 1 FROM commercial_billing_account_tenants WHERE tenant_id = selected.tenant_id)
        OR EXISTS (
          SELECT 1 FROM tenant_commercial_entitlements entitlement
           WHERE entitlement.tenant_id = selected.tenant_id
             AND (entitlement.billing_account_id IS NOT NULL OR entitlement.price_revision_id IS NOT NULL)
        )
        OR EXISTS (SELECT 1 FROM commercial_stripe_subscriptions WHERE tenant_id = selected.tenant_id)
        OR EXISTS (SELECT 1 FROM commercial_stripe_events WHERE tenant_id = selected.tenant_id)
        OR EXISTS (SELECT 1 FROM commercial_charge_facts WHERE tenant_id = selected.tenant_id)
        OR EXISTS (SELECT 1 FROM x402_payment_operations WHERE tenant_id = selected.tenant_id)
        OR EXISTS (SELECT 1 FROM commercial_provider_commands WHERE tenant_id = selected.tenant_id)
        OR EXISTS (
          SELECT 1 FROM api_billing_periods
           WHERE tenant_id = selected.tenant_id
             AND (mode = 'billable_closed' OR chargeable_units <> 0)
        )
        OR EXISTS (SELECT 1 FROM api_billing_adjustments WHERE tenant_id = selected.tenant_id)
      ),
      'scheduler', COALESCE((
        SELECT jsonb_build_object(
          'revision', scheduler.scheduler_revision,
          'deployed_sha', scheduler.deployed_sha,
          'state', scheduler.state,
          'checked_at', scheduler.checked_at,
          'next_run_at', scheduler.next_run_at,
          'fresh', scheduler.checked_at >= clock_timestamp() - interval '15 minutes'
                   AND scheduler.next_run_at > clock_timestamp()
                   AND scheduler.next_run_at <= clock_timestamp() + interval '26 hours'
        )
          FROM commercial_shadow_scheduler_heartbeats scheduler
         WHERE scheduler.environment = 'live'
      ), 'null'::jsonb),
      'protected_tenant_match', selected.tenant_id IN (
        'tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ',
        'tnt_00000000010000000000000000',
        'tnt_01KYAT7A1QRKHTYW9H4RAR2SEX',
        'tnt_01M1GTBQN8R8PB6X6PN73YB6NP'
      )
    ) FROM selected
  ), jsonb_build_object('state', 'not_started'));
$$;

REVOKE ALL ON commercial_shadow_periods,
  commercial_shadow_scheduler_heartbeats,
  commercial_shadow_state_transitions
  FROM PUBLIC;
REVOKE ALL ON FUNCTION start_internal_commercial_shadow(
  TEXT,TEXT,TEXT,JSONB,BYTEA,TEXT,BYTEA,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION transition_internal_commercial_shadow(TEXT,TEXT,TEXT,TEXT,TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_internal_commercial_shadow_zero_billing(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION inspect_internal_commercial_shadow() FROM PUBLIC;

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
      EXECUTE format(
        'REVOKE ALL ON commercial_shadow_periods, commercial_shadow_scheduler_heartbeats, commercial_shadow_state_transitions FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    REVOKE ALL ON commercial_shadow_periods,
      commercial_shadow_scheduler_heartbeats,
      commercial_shadow_state_transitions FROM brain_app;
    GRANT SELECT ON commercial_shadow_periods TO brain_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_privileged') THEN
    REVOKE ALL ON commercial_shadow_periods,
      commercial_shadow_scheduler_heartbeats,
      commercial_shadow_state_transitions FROM brain_privileged;
    GRANT SELECT ON commercial_shadow_periods TO brain_privileged;
    GRANT SELECT ON commercial_shadow_scheduler_heartbeats,
      commercial_shadow_state_transitions TO brain_privileged;
    GRANT EXECUTE ON FUNCTION start_internal_commercial_shadow(
      TEXT,TEXT,TEXT,JSONB,BYTEA,TEXT,BYTEA,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT
    ) TO brain_privileged;
    GRANT EXECUTE ON FUNCTION transition_internal_commercial_shadow(TEXT,TEXT,TEXT,TEXT,TEXT)
      TO brain_privileged;
    GRANT EXECUTE ON FUNCTION inspect_internal_commercial_shadow()
      TO brain_privileged;
  END IF;
END;
$$;

COMMENT ON TABLE commercial_shadow_scheduler_heartbeats IS
  'Phase 4 scheduler readiness. Start requires a ready heartbeat for the exact approved SHA within 15 minutes and a next run within 26 hours.';
COMMENT ON TABLE commercial_shadow_state_transitions IS
  'Immutable protected-operator lifecycle evidence. started_at comes only from the start transaction, never workflow dispatch time.';

COMMIT;
