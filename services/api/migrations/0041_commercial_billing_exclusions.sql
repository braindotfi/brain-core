-- RFC 0011 production shadow safety boundary. An excluded tenant may produce
-- observe-only usage evidence, but it can never enter a billable or provider
-- settlement path without a later reviewed migration removing this fence.

BEGIN;

CREATE TABLE IF NOT EXISTS commercial_billing_exclusions (
  tenant_id             TEXT        PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  exclusion_kind        TEXT        NOT NULL CHECK (
    exclusion_kind IN ('internal_commercial_shadow')
  ),
  reason                TEXT        NOT NULL CHECK (
    char_length(reason) BETWEEN 10 AND 240
    AND reason !~ E'[\r\n]'
  ),
  created_by            TEXT        NOT NULL CHECK (
    char_length(created_by) BETWEEN 1 AND 200
  ),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE commercial_billing_exclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_billing_exclusions FORCE ROW LEVEL SECURITY;

CREATE POLICY commercial_billing_exclusions_tenant_read
  ON commercial_billing_exclusions
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE OR REPLACE FUNCTION reject_commercial_billing_exclusion_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'commercial billing exclusions are immutable';
END;
$$;

CREATE TRIGGER commercial_billing_exclusions_immutable_row
BEFORE UPDATE OR DELETE ON commercial_billing_exclusions
FOR EACH ROW EXECUTE FUNCTION reject_commercial_billing_exclusion_mutation();

CREATE TRIGGER commercial_billing_exclusions_immutable_truncate
BEFORE TRUNCATE ON commercial_billing_exclusions
FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_billing_exclusion_mutation();

CREATE OR REPLACE FUNCTION assert_commercial_billing_exclusion_clean_start()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1 FROM tenants WHERE id = NEW.tenant_id FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM commercial_billing_account_tenants
     WHERE tenant_id = NEW.tenant_id
  ) OR EXISTS (
    SELECT 1
      FROM tenant_commercial_entitlements
     WHERE tenant_id = NEW.tenant_id
       AND (billing_account_id IS NOT NULL OR price_revision_id IS NOT NULL)
  ) OR EXISTS (
    SELECT 1 FROM commercial_stripe_subscriptions WHERE tenant_id = NEW.tenant_id
  ) OR EXISTS (
    SELECT 1 FROM commercial_stripe_events WHERE tenant_id = NEW.tenant_id
  ) OR EXISTS (
    SELECT 1 FROM commercial_charge_facts WHERE tenant_id = NEW.tenant_id
  ) OR EXISTS (
    SELECT 1 FROM x402_payment_operations WHERE tenant_id = NEW.tenant_id
  ) OR EXISTS (
    SELECT 1 FROM commercial_provider_commands WHERE tenant_id = NEW.tenant_id
  ) OR EXISTS (
    SELECT 1
      FROM api_billing_periods
     WHERE tenant_id = NEW.tenant_id
       AND (mode = 'billable_closed' OR chargeable_units <> 0)
  ) OR EXISTS (
    SELECT 1 FROM api_billing_adjustments WHERE tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'tenant already has commercial billing state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER commercial_billing_exclusions_clean_start
BEFORE INSERT ON commercial_billing_exclusions
FOR EACH ROW EXECUTE FUNCTION assert_commercial_billing_exclusion_clean_start();

CREATE OR REPLACE FUNCTION reject_excluded_tenant_commercial_billing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.tenant_id IS NOT NULL THEN
    PERFORM 1 FROM tenants WHERE id = NEW.tenant_id FOR UPDATE;
  END IF;

  IF NEW.tenant_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM commercial_billing_exclusions
     WHERE tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commercial billing is excluded for tenant';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER commercial_billing_account_tenants_exclusion_guard
BEFORE INSERT OR UPDATE ON commercial_billing_account_tenants
FOR EACH ROW EXECUTE FUNCTION reject_excluded_tenant_commercial_billing();

CREATE TRIGGER commercial_stripe_subscriptions_exclusion_guard
BEFORE INSERT OR UPDATE ON commercial_stripe_subscriptions
FOR EACH ROW EXECUTE FUNCTION reject_excluded_tenant_commercial_billing();

CREATE TRIGGER commercial_stripe_events_exclusion_guard
BEFORE INSERT OR UPDATE ON commercial_stripe_events
FOR EACH ROW EXECUTE FUNCTION reject_excluded_tenant_commercial_billing();

CREATE TRIGGER commercial_charge_facts_exclusion_guard
BEFORE INSERT OR UPDATE ON commercial_charge_facts
FOR EACH ROW EXECUTE FUNCTION reject_excluded_tenant_commercial_billing();

CREATE TRIGGER x402_payment_operations_exclusion_guard
BEFORE INSERT OR UPDATE ON x402_payment_operations
FOR EACH ROW EXECUTE FUNCTION reject_excluded_tenant_commercial_billing();

CREATE TRIGGER commercial_provider_commands_exclusion_guard
BEFORE INSERT OR UPDATE ON commercial_provider_commands
FOR EACH ROW EXECUTE FUNCTION reject_excluded_tenant_commercial_billing();

CREATE TRIGGER api_billing_adjustments_exclusion_guard
BEFORE INSERT OR UPDATE ON api_billing_adjustments
FOR EACH ROW EXECUTE FUNCTION reject_excluded_tenant_commercial_billing();

CREATE OR REPLACE FUNCTION reject_excluded_tenant_entitlement_billing_link()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1 FROM tenants WHERE id = NEW.tenant_id FOR UPDATE;

  IF (NEW.billing_account_id IS NOT NULL OR NEW.price_revision_id IS NOT NULL)
     AND EXISTS (
       SELECT 1
         FROM commercial_billing_exclusions
        WHERE tenant_id = NEW.tenant_id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commercial billing is excluded for tenant';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_commercial_entitlements_exclusion_guard
BEFORE INSERT OR UPDATE ON tenant_commercial_entitlements
FOR EACH ROW EXECUTE FUNCTION reject_excluded_tenant_entitlement_billing_link();

CREATE OR REPLACE FUNCTION reject_excluded_tenant_billable_period()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1 FROM tenants WHERE id = NEW.tenant_id FOR UPDATE;

  IF (NEW.mode = 'billable_closed' OR NEW.chargeable_units <> 0)
     AND EXISTS (
       SELECT 1
         FROM commercial_billing_exclusions
        WHERE tenant_id = NEW.tenant_id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commercial billing is excluded for tenant';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER api_billing_periods_exclusion_guard
BEFORE INSERT OR UPDATE ON api_billing_periods
FOR EACH ROW EXECUTE FUNCTION reject_excluded_tenant_billable_period();

CREATE OR REPLACE FUNCTION create_internal_commercial_shadow_billing_exclusion(
  p_tenant_id TEXT,
  p_created_by TEXT,
  p_reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id !~ '^tnt_[0-9A-HJKMNP-TV-Z]{26}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid tenant id';
  END IF;
  IF p_created_by IS NULL OR char_length(p_created_by) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid exclusion actor';
  END IF;
  IF p_reason IS NULL
     OR char_length(p_reason) NOT BETWEEN 10 AND 240
     OR p_reason ~ E'[\r\n]' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid exclusion reason';
  END IF;

  PERFORM 1 FROM tenants WHERE id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'tenant does not exist';
  END IF;

  INSERT INTO commercial_billing_exclusions (
    tenant_id, exclusion_kind, reason, created_by
  ) VALUES (
    p_tenant_id, 'internal_commercial_shadow', p_reason, p_created_by
  )
  ON CONFLICT (tenant_id) DO NOTHING;
END;
$$;

REVOKE ALL PRIVILEGES ON commercial_billing_exclusions FROM PUBLIC;
REVOKE ALL ON FUNCTION create_internal_commercial_shadow_billing_exclusion(
  TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_commercial_billing_exclusion_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_commercial_billing_exclusion_clean_start() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_excluded_tenant_commercial_billing() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_excluded_tenant_entitlement_billing_link() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_excluded_tenant_billable_period() FROM PUBLIC;

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
        'REVOKE ALL PRIVILEGES ON commercial_billing_exclusions FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION create_internal_commercial_shadow_billing_exclusion(TEXT, TEXT, TEXT) FROM %I',
        runtime_role
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_privileged') THEN
    GRANT SELECT ON commercial_billing_exclusions TO brain_privileged;
    GRANT EXECUTE ON FUNCTION create_internal_commercial_shadow_billing_exclusion(
      TEXT, TEXT, TEXT
    ) TO brain_privileged;
  END IF;
END $$;

COMMENT ON TABLE commercial_billing_exclusions IS
  'Immutable tenants that may emit commercial shadow evidence but may never enter billing or provider settlement paths.';
COMMENT ON FUNCTION create_internal_commercial_shadow_billing_exclusion(TEXT, TEXT, TEXT) IS
  'Protected operator entry point for an idempotent internal commercial shadow billing exclusion.';

COMMIT;
