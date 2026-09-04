-- RFC 0009, RFC 0011, and RFC 0012 Phase 1: accepted commercial contracts
-- and disabled foundations. This migration creates no provider credential,
-- initiates no payment, grants no paid entitlement, and enables no enforcement.

BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS business_name TEXT;

COMMENT ON COLUMN tenants.business_name IS
  'Canonical business name used by RobotMoney entity provisioning. Existing values are recovered by the audit-owned backfill.';

CREATE TABLE IF NOT EXISTS commercial_activation_gates (
  feature               TEXT        PRIMARY KEY CHECK (feature IN (
    'catalog',
    'entity_scope',
    'agent_capacity',
    'execution_limits',
    'stripe_billing',
    'x402_payments',
    'outcome_fees',
    'movement_fees'
  )),
  mode                  TEXT        NOT NULL DEFAULT 'disabled'
                                   CHECK (mode IN ('disabled', 'shadow', 'enforced')),
  configuration_revision TEXT,
  changed_by            TEXT,
  changed_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    mode = 'disabled'
    OR (configuration_revision IS NOT NULL AND changed_by IS NOT NULL AND changed_at IS NOT NULL)
  )
);

INSERT INTO commercial_activation_gates (feature)
VALUES
  ('catalog'),
  ('entity_scope'),
  ('agent_capacity'),
  ('execution_limits'),
  ('stripe_billing'),
  ('x402_payments'),
  ('outcome_fees'),
  ('movement_fees')
ON CONFLICT (feature) DO NOTHING;

CREATE TABLE IF NOT EXISTS commercial_fee_policies (
  id                    TEXT        PRIMARY KEY,
  fee_kind              TEXT        NOT NULL CHECK (fee_kind IN (
    'collections_resolved',
    'fraud_stopped',
    'money_moved',
    'foreign_exchange'
  )),
  revision              INTEGER     NOT NULL CHECK (revision > 0),
  rate_basis_points     INTEGER     NOT NULL CHECK (rate_basis_points > 0),
  minimum_minor_units   BIGINT      CHECK (minimum_minor_units IS NULL OR minimum_minor_units >= 0),
  maximum_minor_units   BIGINT      CHECK (maximum_minor_units IS NULL OR maximum_minor_units >= 0),
  settlement_currency   TEXT        NOT NULL DEFAULT 'USD'
                                   CHECK (settlement_currency ~ '^[A-Z]{3}$'),
  evidence_policy       JSONB       NOT NULL,
  effective_at          TIMESTAMPTZ NOT NULL,
  retired_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fee_kind, revision),
  CHECK (retired_at IS NULL OR retired_at > effective_at),
  CHECK (
    maximum_minor_units IS NULL
    OR minimum_minor_units IS NULL
    OR maximum_minor_units >= minimum_minor_units
  )
);

INSERT INTO commercial_fee_policies (
  id, fee_kind, revision, rate_basis_points, minimum_minor_units,
  maximum_minor_units, evidence_policy, effective_at
)
VALUES
  (
    'collections_resolved_v1', 'collections_resolved', 1, 1000, NULL, NULL,
    '{"basis":"net_principal_recovered","attribution_window_days":30,"reversal_window_days":90}'::jsonb,
    '2026-09-03T00:00:00Z'
  ),
  (
    'fraud_stopped_v1', 'fraud_stopped', 1, 200, 1000, NULL,
    '{"basis":"verified_prevented_principal","evidence_window_days":90,"dispute_window_days":30,"uncapped":true}'::jsonb,
    '2026-09-03T00:00:00Z'
  ),
  (
    'money_moved_v1', 'money_moved', 1, 30, NULL, NULL,
    '{"basis":"gross_settled_outgoing_principal","exclude_internal_transfers":true}'::jsonb,
    '2026-09-03T00:00:00Z'
  ),
  (
    'foreign_exchange_v1', 'foreign_exchange', 1, 50, NULL, NULL,
    '{"quote_lock_seconds":60,"adverse_reconfirmation_basis_points":10}'::jsonb,
    '2026-09-03T00:00:00Z'
  )
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS x402_operation_price_policies (
  id                    TEXT        PRIMARY KEY,
  operation_class       TEXT        NOT NULL CHECK (operation_class IN ('api', 'mcp')),
  revision              INTEGER     NOT NULL CHECK (revision > 0),
  scheme                TEXT        NOT NULL CHECK (scheme = 'exact'),
  network               TEXT        NOT NULL,
  asset_symbol          TEXT        NOT NULL,
  asset_decimals        INTEGER     NOT NULL CHECK (asset_decimals >= 0 AND asset_decimals <= 18),
  asset_contract        TEXT,
  amount_atomic         BIGINT      NOT NULL CHECK (amount_atomic > 0),
  quote_ttl_seconds     INTEGER     NOT NULL CHECK (quote_ttl_seconds > 0),
  facilitator           TEXT        NOT NULL CHECK (facilitator = 'coinbase_cdp'),
  pay_to_address        TEXT,
  public                BOOLEAN     NOT NULL DEFAULT FALSE,
  enabled               BOOLEAN     NOT NULL DEFAULT FALSE,
  effective_at          TIMESTAMPTZ NOT NULL,
  retired_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (operation_class, revision),
  CHECK (retired_at IS NULL OR retired_at > effective_at),
  CHECK (enabled = FALSE OR (asset_contract IS NOT NULL AND pay_to_address IS NOT NULL))
);

INSERT INTO x402_operation_price_policies (
  id, operation_class, revision, scheme, network, asset_symbol,
  asset_decimals, amount_atomic, quote_ttl_seconds, facilitator,
  public, enabled, effective_at
)
VALUES
  (
    'x402_api_base_mainnet_v1', 'api', 1, 'exact', 'eip155:8453', 'USDC',
    6, 10000, 60, 'coinbase_cdp', FALSE, FALSE, '2026-09-03T00:00:00Z'
  ),
  (
    'x402_mcp_base_mainnet_v1', 'mcp', 1, 'exact', 'eip155:8453', 'USDC',
    6, 100000, 60, 'coinbase_cdp', FALSE, FALSE, '2026-09-03T00:00:00Z'
  )
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS api_commercial_tier_catalog (
  id                    TEXT        PRIMARY KEY,
  public_tier_id        TEXT        NOT NULL,
  revision              INTEGER     NOT NULL CHECK (revision > 0),
  brand                 TEXT        NOT NULL CHECK (brand = 'RobotMoney'),
  display_name          TEXT        NOT NULL,
  description           TEXT        NOT NULL,
  terms_version         TEXT        NOT NULL,
  target_rate_tier_id   TEXT        NOT NULL REFERENCES api_rate_limit_tiers(id),
  billing_mode          TEXT        NOT NULL CHECK (billing_mode IN (
    'unpaid', 'stripe_subscription', 'stripe_invoice'
  )),
  price_minor_units     BIGINT      CHECK (price_minor_units IS NULL OR price_minor_units >= 0),
  currency              TEXT        CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  billing_interval      TEXT        CHECK (
    billing_interval IS NULL OR billing_interval IN ('month', 'year')
  ),
  price_display         TEXT        NOT NULL,
  maximum_agents        INTEGER     CHECK (maximum_agents IS NULL OR maximum_agents > 0),
  maximum_entities      INTEGER     CHECK (maximum_entities IS NULL OR maximum_entities > 0),
  execution_limit_minor_units BIGINT CHECK (
    execution_limit_minor_units IS NULL OR execution_limit_minor_units > 0
  ),
  execution_limit_currency TEXT     CHECK (
    execution_limit_currency IS NULL OR execution_limit_currency ~ '^[A-Z]{3}$'
  ),
  execution_period      TEXT        CHECK (execution_period IS NULL OR execution_period = 'month'),
  execution_scope       TEXT        CHECK (
    execution_scope IS NULL OR execution_scope IN ('per_entity', 'contract')
  ),
  external_api_access  TEXT         NOT NULL CHECK (external_api_access IN (
    'none', 'included', 'contract'
  )),
  external_mcp_access  TEXT         NOT NULL CHECK (external_mcp_access IN (
    'none', 'included', 'contract'
  )),
  included_api_units    BIGINT      CHECK (included_api_units IS NULL OR included_api_units >= 0),
  included_mcp_units    BIGINT      CHECK (included_mcp_units IS NULL OR included_mcp_units >= 0),
  x402_api_price_policy_id TEXT     REFERENCES x402_operation_price_policies(id),
  x402_mcp_price_policy_id TEXT     REFERENCES x402_operation_price_policies(id),
  collections_fee_policy_id TEXT    REFERENCES commercial_fee_policies(id),
  fraud_fee_policy_id   TEXT        REFERENCES commercial_fee_policies(id),
  movement_fee_policy_id TEXT       REFERENCES commercial_fee_policies(id),
  fx_fee_policy_id      TEXT        REFERENCES commercial_fee_policies(id),
  contract_specific     BOOLEAN     NOT NULL DEFAULT FALSE,
  placeholder           BOOLEAN     NOT NULL DEFAULT FALSE CHECK (placeholder = FALSE),
  public                BOOLEAN     NOT NULL DEFAULT TRUE,
  self_serve_enabled    BOOLEAN     NOT NULL DEFAULT FALSE,
  operator_only         BOOLEAN     NOT NULL DEFAULT FALSE,
  sort_order            INTEGER     NOT NULL DEFAULT 0,
  effective_at          TIMESTAMPTZ NOT NULL,
  retired_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (public_tier_id, revision),
  CHECK (retired_at IS NULL OR retired_at > effective_at),
  CHECK (NOT (self_serve_enabled AND operator_only)),
  CHECK (
    contract_specific
    OR (
      maximum_agents IS NOT NULL
      AND maximum_entities IS NOT NULL
      AND execution_limit_minor_units IS NOT NULL
      AND execution_limit_currency = 'USD'
      AND execution_period = 'month'
      AND execution_scope = 'per_entity'
      AND included_api_units IS NOT NULL
      AND included_mcp_units IS NOT NULL
    )
  )
);

INSERT INTO api_commercial_tier_catalog (
  id, public_tier_id, revision, brand, display_name, description, terms_version,
  target_rate_tier_id, billing_mode, price_minor_units, currency,
  billing_interval, price_display, maximum_agents, maximum_entities,
  execution_limit_minor_units, execution_limit_currency, execution_period,
  execution_scope, external_api_access, external_mcp_access,
  included_api_units, included_mcp_units, x402_api_price_policy_id,
  x402_mcp_price_policy_id, collections_fee_policy_id, fraud_fee_policy_id,
  movement_fee_policy_id, fx_fee_policy_id, contract_specific, placeholder,
  public, self_serve_enabled, operator_only, sort_order, effective_at
)
VALUES
  (
    'robotmoney_free_v1', 'free', 1, 'RobotMoney', 'Free',
    'One agent and one entity with a $5,000 monthly execution limit.',
    'robotmoney_terms_v1', 'starter_v1', 'unpaid', 0, 'USD', NULL, '$0',
    1, 1, 500000, 'USD', 'month', 'per_entity', 'none', 'none', 0, 0,
    'x402_api_base_mainnet_v1', 'x402_mcp_base_mainnet_v1',
    'collections_resolved_v1', 'fraud_stopped_v1', 'money_moved_v1',
    'foreign_exchange_v1', FALSE, FALSE, TRUE, FALSE, FALSE, 10,
    '2026-09-03T00:00:00Z'
  ),
  (
    'robotmoney_starter_v1', 'starter', 1, 'RobotMoney', 'Starter',
    'Two agents and one entity with a $25,000 monthly execution limit.',
    'robotmoney_terms_v1', 'starter_v1', 'stripe_subscription', 9900, 'USD',
    'month', '$99 per month', 2, 1, 2500000, 'USD', 'month', 'per_entity',
    'none', 'none', 0, 0, 'x402_api_base_mainnet_v1',
    'x402_mcp_base_mainnet_v1', 'collections_resolved_v1', 'fraud_stopped_v1',
    'money_moved_v1', 'foreign_exchange_v1', FALSE, FALSE, TRUE, FALSE, FALSE,
    20, '2026-09-03T00:00:00Z'
  ),
  (
    'robotmoney_growth_v1', 'growth', 1, 'RobotMoney', 'Growth',
    'Five agents, one entity, and included API and MCP allowances.',
    'robotmoney_terms_v1', 'standard_v1', 'stripe_subscription', 49900, 'USD',
    'month', '$499 per month', 5, 1, 25000000, 'USD', 'month', 'per_entity',
    'included', 'included', 25000, 2500, 'x402_api_base_mainnet_v1',
    'x402_mcp_base_mainnet_v1', 'collections_resolved_v1', 'fraud_stopped_v1',
    'money_moved_v1', 'foreign_exchange_v1', FALSE, FALSE, TRUE, FALSE, FALSE,
    30, '2026-09-03T00:00:00Z'
  ),
  (
    'robotmoney_scale_v1', 'scale', 1, 'RobotMoney', 'Scale',
    'Eleven agents and up to ten entities with higher included allowances.',
    'robotmoney_terms_v1', 'scale_v1', 'stripe_subscription', 250000, 'USD',
    'month', '$2,500 per month', 11, 10, 250000000, 'USD', 'month',
    'per_entity', 'included', 'included', 250000, 25000,
    'x402_api_base_mainnet_v1', 'x402_mcp_base_mainnet_v1',
    'collections_resolved_v1', 'fraud_stopped_v1', 'money_moved_v1',
    'foreign_exchange_v1', FALSE, FALSE, TRUE, FALSE, FALSE, 40,
    '2026-09-03T00:00:00Z'
  ),
  (
    'robotmoney_enterprise_v1', 'enterprise', 1, 'RobotMoney', 'Enterprise',
    'Contract-specific agents, unlimited entities, execution limits, and usage.',
    'robotmoney_terms_v1', 'enterprise_v1', 'stripe_invoice', NULL, 'USD', NULL,
    '$10,000 to $50,000 per month, custom', NULL, NULL, NULL, NULL, NULL,
    'contract', 'contract', 'contract', NULL, NULL, NULL, NULL,
    'collections_resolved_v1', 'fraud_stopped_v1', 'money_moved_v1',
    'foreign_exchange_v1', TRUE, FALSE, TRUE, FALSE, TRUE, 50,
    '2026-09-03T00:00:00Z'
  )
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS commercial_tier_prices (
  id                    TEXT        PRIMARY KEY,
  catalog_revision_id   TEXT        NOT NULL REFERENCES api_commercial_tier_catalog(id),
  currency              TEXT        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  billing_interval      TEXT        NOT NULL CHECK (billing_interval IN ('month', 'year')),
  amount_minor_units    BIGINT      NOT NULL CHECK (amount_minor_units >= 0),
  payment_rail          TEXT        NOT NULL CHECK (payment_rail IN (
    'none', 'stripe_subscription', 'stripe_invoice'
  )),
  provider_price_reference TEXT,
  price_book_revision   INTEGER     NOT NULL CHECK (price_book_revision > 0),
  source_currency       TEXT        NOT NULL CHECK (source_currency ~ '^[A-Z]{3}$'),
  spot_rate             NUMERIC(30, 12) NOT NULL CHECK (spot_rate > 0),
  spot_rate_at          TIMESTAMPTZ NOT NULL,
  spot_rate_source      TEXT        NOT NULL,
  currency_risk_buffer_basis_points INTEGER NOT NULL DEFAULT 0
                                   CHECK (currency_risk_buffer_basis_points >= 0),
  rounding_decimal_places INTEGER  NOT NULL DEFAULT 2 CHECK (rounding_decimal_places = 2),
  public                BOOLEAN     NOT NULL DEFAULT TRUE,
  self_serve_enabled    BOOLEAN     NOT NULL DEFAULT FALSE,
  effective_at          TIMESTAMPTZ NOT NULL,
  retired_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (catalog_revision_id, currency, billing_interval, price_book_revision),
  CHECK (retired_at IS NULL OR retired_at > effective_at),
  CHECK (
    self_serve_enabled = FALSE
    OR (payment_rail = 'stripe_subscription' AND provider_price_reference IS NOT NULL)
  )
);

INSERT INTO commercial_tier_prices (
  id, catalog_revision_id, currency, billing_interval, amount_minor_units,
  payment_rail, price_book_revision, source_currency, spot_rate, spot_rate_at,
  spot_rate_source, currency_risk_buffer_basis_points, rounding_decimal_places,
  public, self_serve_enabled, effective_at
)
VALUES
  ('robotmoney_free_usd_month_v1', 'robotmoney_free_v1', 'USD', 'month', 0, 'none', 1, 'USD', 1, '2026-09-03T11:21:00Z', 'contract_usd_list_price', 0, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_free_eur_month_v1', 'robotmoney_free_v1', 'EUR', 'month', 0, 'none', 1, 'USD', 0.8611, '2026-09-03T11:21:00Z', 'exchangerates_uk_spot', 200, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_free_gbp_month_v1', 'robotmoney_free_v1', 'GBP', 'month', 0, 'none', 1, 'USD', 0.7410, '2026-09-03T12:07:00Z', 'exchangerates_uk_spot', 200, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_starter_usd_month_v1', 'robotmoney_starter_v1', 'USD', 'month', 9900, 'stripe_subscription', 1, 'USD', 1, '2026-09-03T11:21:00Z', 'contract_usd_list_price', 0, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_starter_usd_year_v1', 'robotmoney_starter_v1', 'USD', 'year', 99000, 'stripe_subscription', 1, 'USD', 1, '2026-09-03T11:21:00Z', 'contract_usd_list_price', 0, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_starter_eur_month_v1', 'robotmoney_starter_v1', 'EUR', 'month', 8695, 'stripe_subscription', 1, 'USD', 0.8611, '2026-09-03T11:21:00Z', 'exchangerates_uk_spot', 200, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_starter_eur_year_v1', 'robotmoney_starter_v1', 'EUR', 'year', 86950, 'stripe_subscription', 1, 'USD', 0.8611, '2026-09-03T11:21:00Z', 'exchangerates_uk_spot', 200, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_starter_gbp_month_v1', 'robotmoney_starter_v1', 'GBP', 'month', 7483, 'stripe_subscription', 1, 'USD', 0.7410, '2026-09-03T12:07:00Z', 'exchangerates_uk_spot', 200, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_starter_gbp_year_v1', 'robotmoney_starter_v1', 'GBP', 'year', 74830, 'stripe_subscription', 1, 'USD', 0.7410, '2026-09-03T12:07:00Z', 'exchangerates_uk_spot', 200, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_growth_usd_month_v1', 'robotmoney_growth_v1', 'USD', 'month', 49900, 'stripe_subscription', 1, 'USD', 1, '2026-09-03T11:21:00Z', 'contract_usd_list_price', 0, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_growth_usd_year_v1', 'robotmoney_growth_v1', 'USD', 'year', 499000, 'stripe_subscription', 1, 'USD', 1, '2026-09-03T11:21:00Z', 'contract_usd_list_price', 0, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_growth_eur_month_v1', 'robotmoney_growth_v1', 'EUR', 'month', 43828, 'stripe_subscription', 1, 'USD', 0.8611, '2026-09-03T11:21:00Z', 'exchangerates_uk_spot', 200, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_growth_eur_year_v1', 'robotmoney_growth_v1', 'EUR', 'year', 438280, 'stripe_subscription', 1, 'USD', 0.8611, '2026-09-03T11:21:00Z', 'exchangerates_uk_spot', 200, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_growth_gbp_month_v1', 'robotmoney_growth_v1', 'GBP', 'month', 37715, 'stripe_subscription', 1, 'USD', 0.7410, '2026-09-03T12:07:00Z', 'exchangerates_uk_spot', 200, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_growth_gbp_year_v1', 'robotmoney_growth_v1', 'GBP', 'year', 377150, 'stripe_subscription', 1, 'USD', 0.7410, '2026-09-03T12:07:00Z', 'exchangerates_uk_spot', 200, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_scale_usd_month_v1', 'robotmoney_scale_v1', 'USD', 'month', 250000, 'stripe_subscription', 1, 'USD', 1, '2026-09-03T11:21:00Z', 'contract_usd_list_price', 0, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_scale_usd_year_v1', 'robotmoney_scale_v1', 'USD', 'year', 2500000, 'stripe_subscription', 1, 'USD', 1, '2026-09-03T11:21:00Z', 'contract_usd_list_price', 0, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_scale_eur_month_v1', 'robotmoney_scale_v1', 'EUR', 'month', 219581, 'stripe_subscription', 1, 'USD', 0.8611, '2026-09-03T11:21:00Z', 'exchangerates_uk_spot', 200, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_scale_eur_year_v1', 'robotmoney_scale_v1', 'EUR', 'year', 2195810, 'stripe_subscription', 1, 'USD', 0.8611, '2026-09-03T11:21:00Z', 'exchangerates_uk_spot', 200, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_scale_gbp_month_v1', 'robotmoney_scale_v1', 'GBP', 'month', 188955, 'stripe_subscription', 1, 'USD', 0.7410, '2026-09-03T12:07:00Z', 'exchangerates_uk_spot', 200, 2, TRUE, FALSE, '2026-09-03T00:00:00Z'),
  ('robotmoney_scale_gbp_year_v1', 'robotmoney_scale_v1', 'GBP', 'year', 1889550, 'stripe_subscription', 1, 'USD', 0.7410, '2026-09-03T12:07:00Z', 'exchangerates_uk_spot', 200, 2, TRUE, FALSE, '2026-09-03T00:00:00Z')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS commercial_tier_transitions (
  from_catalog_revision_id TEXT     NOT NULL REFERENCES api_commercial_tier_catalog(id),
  to_catalog_revision_id   TEXT     NOT NULL REFERENCES api_commercial_tier_catalog(id),
  transition_kind       TEXT        NOT NULL CHECK (transition_kind IN ('upgrade', 'downgrade')),
  public_self_serve      BOOLEAN     NOT NULL DEFAULT FALSE,
  effective_timing      TEXT        NOT NULL CHECK (effective_timing IN ('immediate', 'period_end')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_catalog_revision_id, to_catalog_revision_id),
  CHECK (from_catalog_revision_id <> to_catalog_revision_id)
);

CREATE TABLE IF NOT EXISTS commercial_billing_accounts (
  id                    TEXT        PRIMARY KEY,
  status                TEXT        NOT NULL CHECK (status IN ('pending', 'active', 'restricted', 'closed')),
  billing_currency      TEXT        NOT NULL CHECK (billing_currency IN ('USD', 'EUR', 'GBP')),
  tax_configuration_status TEXT     NOT NULL DEFAULT 'pending'
                                   CHECK (tax_configuration_status IN ('pending', 'approved')),
  version               INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by            TEXT        NOT NULL,
  final_tenant_unlinked_at TIMESTAMPTZ,
  retain_until          TIMESTAMPTZ,
  retention_reason      TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commercial_billing_account_tenants (
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  billing_account_id    TEXT        NOT NULL REFERENCES commercial_billing_accounts(id),
  relationship          TEXT        NOT NULL CHECK (relationship IN ('production', 'retained_demo')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, billing_account_id)
);

CREATE OR REPLACE FUNCTION retain_unlinked_commercial_billing_account()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM commercial_billing_account_tenants
     WHERE billing_account_id = OLD.billing_account_id
  ) THEN
    UPDATE commercial_billing_accounts
       SET status = 'closed',
           final_tenant_unlinked_at = now(),
           retain_until = GREATEST(COALESCE(retain_until, '-infinity'::timestamptz), now() + interval '7 years'),
           retention_reason = 'accounting_and_settlement_evidence',
           version = version + 1,
           updated_at = now()
     WHERE id = OLD.billing_account_id;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER commercial_billing_account_final_unlink_retention
AFTER DELETE ON commercial_billing_account_tenants
FOR EACH ROW EXECUTE FUNCTION retain_unlinked_commercial_billing_account();

CREATE TABLE IF NOT EXISTS robotmoney_entities (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name          TEXT        NOT NULL,
  legal_name            TEXT,
  state                 TEXT        NOT NULL CHECK (state IN (
    'draft', 'active', 'capacity_paused', 'deactivated'
  )),
  commercial_cap_revision_id TEXT   REFERENCES api_commercial_tier_catalog(id),
  version               INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by            TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS robotmoney_agent_instances (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_id             TEXT        NOT NULL,
  runtime_agent_id      TEXT,
  display_name          TEXT        NOT NULL,
  lifecycle_state       TEXT        NOT NULL CHECK (lifecycle_state IN (
    'draft', 'active', 'capacity_paused', 'deleted'
  )),
  system_bootstrap      BOOLEAN     NOT NULL DEFAULT FALSE,
  demo_instance         BOOLEAN     NOT NULL DEFAULT FALSE,
  version               INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by            TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, entity_id)
    REFERENCES robotmoney_entities(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, runtime_agent_id)
);

CREATE TABLE IF NOT EXISTS tenant_commercial_entitlements (
  tenant_id             TEXT        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  catalog_revision_id   TEXT        NOT NULL REFERENCES api_commercial_tier_catalog(id),
  price_revision_id     TEXT        REFERENCES commercial_tier_prices(id),
  billing_account_id    TEXT        REFERENCES commercial_billing_accounts(id),
  lifecycle_status      TEXT        NOT NULL CHECK (lifecycle_status IN (
    'active', 'restricted', 'canceling', 'canceled'
  )),
  access_status         TEXT        NOT NULL CHECK (access_status IN ('active', 'restricted')),
  source                TEXT        NOT NULL,
  version               INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
  effective_at          TIMESTAMPTZ NOT NULL,
  period_start          TIMESTAMPTZ,
  period_end            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end IS NULL OR (period_start IS NOT NULL AND period_end > period_start))
);

CREATE TABLE IF NOT EXISTS commercial_stripe_subscriptions (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  billing_account_id    TEXT        NOT NULL REFERENCES commercial_billing_accounts(id),
  catalog_revision_id   TEXT        NOT NULL REFERENCES api_commercial_tier_catalog(id),
  price_revision_id     TEXT        NOT NULL REFERENCES commercial_tier_prices(id),
  provider_mode         TEXT        NOT NULL CHECK (provider_mode IN ('test', 'live')),
  stripe_customer_id    TEXT,
  stripe_subscription_id TEXT,
  stripe_subscription_item_id TEXT,
  status                TEXT        NOT NULL CHECK (status IN (
    'pending', 'active', 'past_due', 'canceled', 'incomplete'
  )),
  payment_method_present BOOLEAN,
  current_period_start  TIMESTAMPTZ,
  current_period_end    TIMESTAMPTZ,
  provider_version      TEXT,
  last_event_created_at TIMESTAMPTZ,
  last_event_id         TEXT,
  version               INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (provider_mode, stripe_subscription_id)
);

CREATE TABLE IF NOT EXISTS commercial_stripe_events (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        REFERENCES tenants(id) ON DELETE CASCADE,
  billing_account_id    TEXT        REFERENCES commercial_billing_accounts(id),
  provider_mode         TEXT        NOT NULL CHECK (provider_mode IN ('test', 'live')),
  stripe_event_id       TEXT        NOT NULL,
  event_type            TEXT        NOT NULL,
  event_created_at      TIMESTAMPTZ NOT NULL,
  payload               JSONB       NOT NULL,
  status                TEXT        NOT NULL CHECK (status IN (
    'received', 'applied', 'ignored', 'failed'
  )),
  failure_code          TEXT,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at            TIMESTAMPTZ,
  UNIQUE (provider_mode, stripe_event_id)
);

CREATE TABLE IF NOT EXISTS api_usage_allowance_counters (
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operation_class       TEXT        NOT NULL CHECK (operation_class IN ('api', 'mcp')),
  period_start          TIMESTAMPTZ NOT NULL,
  period_end            TIMESTAMPTZ NOT NULL,
  catalog_revision_id   TEXT        NOT NULL REFERENCES api_commercial_tier_catalog(id),
  allowance_units       BIGINT      NOT NULL CHECK (allowance_units >= 0),
  consumed_units        BIGINT      NOT NULL DEFAULT 0 CHECK (consumed_units >= 0),
  reserved_units        BIGINT      NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  version               INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_class, period_start),
  CHECK (period_end > period_start),
  CHECK (consumed_units + reserved_units <= allowance_units)
);

CREATE TABLE IF NOT EXISTS api_usage_allowance_reservations (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operation_class       TEXT        NOT NULL CHECK (operation_class IN ('api', 'mcp')),
  period_start          TIMESTAMPTZ NOT NULL,
  logical_operation_id  TEXT        NOT NULL,
  units                 BIGINT      NOT NULL DEFAULT 1 CHECK (units > 0),
  status                TEXT        NOT NULL CHECK (status IN (
    'reserved', 'consumed', 'released', 'expired'
  )),
  expires_at            TIMESTAMPTZ NOT NULL,
  finalized_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, operation_class, period_start)
    REFERENCES api_usage_allowance_counters(tenant_id, operation_class, period_start),
  UNIQUE (tenant_id, operation_class, period_start, logical_operation_id)
);

CREATE TABLE IF NOT EXISTS commercial_execution_periods (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_id             TEXT        NOT NULL,
  period_start          TIMESTAMPTZ NOT NULL,
  period_end            TIMESTAMPTZ NOT NULL,
  catalog_revision_id   TEXT        NOT NULL REFERENCES api_commercial_tier_catalog(id),
  limit_currency        TEXT        NOT NULL CHECK (limit_currency = 'USD'),
  limit_minor_units     BIGINT      NOT NULL CHECK (limit_minor_units > 0),
  settled_minor_units   BIGINT      NOT NULL DEFAULT 0 CHECK (settled_minor_units >= 0),
  reserved_minor_units  BIGINT      NOT NULL DEFAULT 0 CHECK (reserved_minor_units >= 0),
  reversed_minor_units  BIGINT      NOT NULL DEFAULT 0 CHECK (reversed_minor_units >= 0),
  version               INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, entity_id)
    REFERENCES robotmoney_entities(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entity_id, period_start),
  CHECK (period_end > period_start),
  CHECK (reversed_minor_units <= settled_minor_units),
  CHECK (settled_minor_units - reversed_minor_units + reserved_minor_units <= limit_minor_units)
);

CREATE TABLE IF NOT EXISTS commercial_execution_reservations (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_id             TEXT        NOT NULL,
  execution_period_id   TEXT        NOT NULL,
  logical_movement_id   TEXT        NOT NULL,
  source_amount_minor_units BIGINT  NOT NULL CHECK (source_amount_minor_units > 0),
  source_currency       TEXT        NOT NULL CHECK (source_currency ~ '^[A-Z]{3}$'),
  reference_rate        NUMERIC(30, 12) NOT NULL CHECK (reference_rate > 0),
  reference_rate_at     TIMESTAMPTZ NOT NULL,
  usd_equivalent_minor_units BIGINT NOT NULL CHECK (usd_equivalent_minor_units > 0),
  status                TEXT        NOT NULL CHECK (status IN (
    'reserved', 'settled', 'released', 'partially_reversed', 'reversed'
  )),
  expires_at            TIMESTAMPTZ,
  settled_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, entity_id)
    REFERENCES robotmoney_entities(tenant_id, id),
  FOREIGN KEY (tenant_id, execution_period_id)
    REFERENCES commercial_execution_periods(tenant_id, id),
  UNIQUE (tenant_id, logical_movement_id)
);

CREATE TABLE IF NOT EXISTS commercial_execution_adjustments (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  execution_period_id   TEXT        NOT NULL,
  amount_minor_units    BIGINT      NOT NULL CHECK (amount_minor_units <> 0),
  reason                TEXT        NOT NULL,
  source_evidence       JSONB       NOT NULL,
  responsibility_label TEXT        NOT NULL,
  actor                 TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, execution_period_id)
    REFERENCES commercial_execution_periods(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS commercial_charge_facts (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  billing_account_id    TEXT        NOT NULL REFERENCES commercial_billing_accounts(id),
  charge_kind           TEXT        NOT NULL CHECK (charge_kind IN (
    'collections_resolved', 'fraud_stopped', 'money_moved', 'foreign_exchange'
  )),
  fee_policy_id         TEXT        NOT NULL REFERENCES commercial_fee_policies(id),
  source_reference      TEXT        NOT NULL,
  source_evidence       JSONB       NOT NULL,
  basis_amount_minor_units BIGINT   NOT NULL CHECK (basis_amount_minor_units >= 0),
  fee_amount_minor_units BIGINT     NOT NULL CHECK (fee_amount_minor_units >= 0),
  currency              TEXT        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status                TEXT        NOT NULL CHECK (status IN (
    'provisional', 'finalized', 'reversed', 'disputed'
  )),
  finalizes_at          TIMESTAMPTZ,
  finalized_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, charge_kind, source_reference)
);

CREATE TABLE IF NOT EXISTS x402_payment_operations (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        REFERENCES tenants(id) ON DELETE CASCADE,
  entity_id             TEXT,
  environment           TEXT        NOT NULL CHECK (environment IN ('sandbox', 'live')),
  operation_class       TEXT        NOT NULL CHECK (operation_class IN ('api', 'mcp')),
  operation_id          TEXT        NOT NULL,
  logical_operation_id  TEXT        NOT NULL,
  price_policy_id       TEXT        NOT NULL REFERENCES x402_operation_price_policies(id),
  quote_digest          TEXT        NOT NULL,
  payment_payload_digest TEXT,
  payer_address         TEXT,
  network               TEXT        NOT NULL,
  asset_contract        TEXT,
  recipient_address     TEXT,
  amount_atomic         BIGINT      NOT NULL CHECK (amount_atomic > 0),
  quote_expires_at      TIMESTAMPTZ NOT NULL,
  facilitator_status    TEXT        NOT NULL CHECK (facilitator_status IN (
    'not_requested', 'verified', 'rejected', 'settled', 'failed'
  )),
  settlement_tx_hash    TEXT,
  l2_inclusion_status   TEXT        NOT NULL CHECK (l2_inclusion_status IN (
    'not_checked', 'sealed', 'reorged'
  )),
  l1_inclusion_status   TEXT        NOT NULL CHECK (l1_inclusion_status IN (
    'not_checked', 'included', 'failed'
  )),
  fulfillment_status    TEXT        NOT NULL CHECK (fulfillment_status IN (
    'pending', 'fulfilled', 'service_failed', 'refunded'
  )),
  response_digest       TEXT,
  refund_tx_hash        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at           TIMESTAMPTZ,
  settled_at            TIMESTAMPTZ,
  fulfilled_at          TIMESTAMPTZ,
  reconciled_at         TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, entity_id)
    REFERENCES robotmoney_entities(tenant_id, id),
  CHECK ((tenant_id IS NULL AND entity_id IS NULL) OR tenant_id IS NOT NULL),
  UNIQUE (environment, logical_operation_id)
);

CREATE TABLE IF NOT EXISTS commercial_provider_commands (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        REFERENCES tenants(id) ON DELETE CASCADE,
  billing_account_id    TEXT        REFERENCES commercial_billing_accounts(id),
  provider              TEXT        NOT NULL CHECK (provider IN ('stripe', 'coinbase_cdp', 'base')),
  provider_mode         TEXT        NOT NULL CHECK (provider_mode IN ('test', 'live')),
  command_type          TEXT        NOT NULL,
  idempotency_key       TEXT        NOT NULL,
  request_envelope      JSONB       NOT NULL,
  status                TEXT        NOT NULL CHECK (status IN (
    'pending', 'dispatched', 'succeeded', 'failed', 'canceled'
  )),
  attempt_count         INTEGER     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at       TIMESTAMPTZ,
  provider_reference    TEXT,
  failure_code          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_mode, idempotency_key)
);

CREATE TABLE IF NOT EXISTS commercial_responsibility_assignments (
  responsibility_label  TEXT        PRIMARY KEY CHECK (responsibility_label IN (
    'finance_controller',
    'treasury',
    'security',
    'billing_engineering',
    'product',
    'brainmvb_client',
    'core',
    'platform'
  )),
  assignee_actor_id     TEXT,
  assignee_display_name TEXT        NOT NULL DEFAULT 'Damon',
  effective_at          TIMESTAMPTZ,
  assigned_by           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    assignee_actor_id IS NULL
    OR (effective_at IS NOT NULL AND assigned_by IS NOT NULL)
  )
);

INSERT INTO commercial_responsibility_assignments (responsibility_label)
VALUES
  ('finance_controller'),
  ('treasury'),
  ('security'),
  ('billing_engineering'),
  ('product'),
  ('brainmvb_client'),
  ('core'),
  ('platform')
ON CONFLICT (responsibility_label) DO NOTHING;

UPDATE commercial_responsibility_assignments
   SET assignee_actor_id = 'user_01M0NTPB2292Z4BF5BHVEM41C6',
       assignee_display_name = 'Damon',
       effective_at = '2026-09-03T00:00:00Z',
       assigned_by = 'user_01M0NTPB2292Z4BF5BHVEM41C6'
 WHERE assignee_actor_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_commercial_catalog_public
  ON api_commercial_tier_catalog (public, self_serve_enabled, sort_order, effective_at)
  WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_robotmoney_entities_tenant_state
  ON robotmoney_entities (tenant_id, state, id);
CREATE INDEX IF NOT EXISTS idx_robotmoney_agents_tenant_state
  ON robotmoney_agent_instances (tenant_id, lifecycle_state, id);
CREATE INDEX IF NOT EXISTS idx_commercial_stripe_events_status
  ON commercial_stripe_events (status, received_at, id);
CREATE INDEX IF NOT EXISTS idx_api_allowance_reservations_expiry
  ON api_usage_allowance_reservations (status, expires_at, id);
CREATE INDEX IF NOT EXISTS idx_execution_reservations_status
  ON commercial_execution_reservations (tenant_id, status, expires_at, id);
CREATE INDEX IF NOT EXISTS idx_x402_operations_reconciliation
  ON x402_payment_operations (facilitator_status, fulfillment_status, reconciled_at, id);
CREATE INDEX IF NOT EXISTS idx_commercial_provider_commands_dispatch
  ON commercial_provider_commands (provider, provider_mode, status, next_attempt_at, id);

ALTER TABLE commercial_billing_account_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_billing_account_tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE robotmoney_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE robotmoney_entities FORCE ROW LEVEL SECURITY;
ALTER TABLE robotmoney_agent_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE robotmoney_agent_instances FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_commercial_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_commercial_entitlements FORCE ROW LEVEL SECURITY;
ALTER TABLE commercial_stripe_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_stripe_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE commercial_stripe_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_stripe_events FORCE ROW LEVEL SECURITY;
ALTER TABLE api_usage_allowance_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage_allowance_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE api_usage_allowance_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage_allowance_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE commercial_execution_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_execution_periods FORCE ROW LEVEL SECURITY;
ALTER TABLE commercial_execution_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_execution_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE commercial_execution_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_execution_adjustments FORCE ROW LEVEL SECURITY;
ALTER TABLE commercial_charge_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_charge_facts FORCE ROW LEVEL SECURITY;
ALTER TABLE x402_payment_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE x402_payment_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE commercial_provider_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_provider_commands FORCE ROW LEVEL SECURITY;

CREATE POLICY commercial_billing_account_tenants_read ON commercial_billing_account_tenants
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY robotmoney_entities_tenant_read ON robotmoney_entities
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY robotmoney_agent_instances_tenant_read ON robotmoney_agent_instances
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_commercial_entitlements_read ON tenant_commercial_entitlements
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY commercial_stripe_subscriptions_tenant_read ON commercial_stripe_subscriptions
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY commercial_stripe_events_tenant_read ON commercial_stripe_events
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY api_usage_allowance_counters_tenant_read ON api_usage_allowance_counters
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY api_usage_allowance_reservations_tenant_read ON api_usage_allowance_reservations
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY commercial_execution_periods_tenant_read ON commercial_execution_periods
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY commercial_execution_reservations_tenant_read ON commercial_execution_reservations
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY commercial_execution_adjustments_tenant_read ON commercial_execution_adjustments
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY commercial_charge_facts_tenant_read ON commercial_charge_facts
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY x402_payment_operations_tenant_read ON x402_payment_operations
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY commercial_provider_commands_tenant_read ON commercial_provider_commands
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_activation_gates FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_fee_policies FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON x402_operation_price_policies FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON api_commercial_tier_catalog FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_tier_prices FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_tier_transitions FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_billing_accounts FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_billing_account_tenants FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON robotmoney_entities FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON robotmoney_agent_instances FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON tenant_commercial_entitlements FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_stripe_subscriptions FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_stripe_events FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON api_usage_allowance_counters FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON api_usage_allowance_reservations FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_execution_periods FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_execution_reservations FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_execution_adjustments FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_charge_facts FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON x402_payment_operations FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_provider_commands FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_responsibility_assignments FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    GRANT SELECT ON commercial_activation_gates, commercial_fee_policies,
      x402_operation_price_policies, api_commercial_tier_catalog,
      commercial_tier_prices, commercial_tier_transitions,
      commercial_billing_account_tenants, robotmoney_entities,
      robotmoney_agent_instances, tenant_commercial_entitlements,
      commercial_stripe_subscriptions, api_usage_allowance_counters,
      api_usage_allowance_reservations, commercial_execution_periods,
      commercial_execution_reservations, commercial_execution_adjustments,
      commercial_charge_facts, x402_payment_operations TO brain_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_activation_gates,
      commercial_fee_policies, x402_operation_price_policies,
      api_commercial_tier_catalog, commercial_tier_prices,
      commercial_tier_transitions, commercial_billing_accounts,
      commercial_billing_account_tenants, robotmoney_entities,
      robotmoney_agent_instances, tenant_commercial_entitlements,
      commercial_stripe_subscriptions, commercial_stripe_events,
      api_usage_allowance_counters, api_usage_allowance_reservations,
      commercial_execution_periods, commercial_execution_reservations,
      commercial_execution_adjustments, commercial_charge_facts,
      x402_payment_operations, commercial_provider_commands,
      commercial_responsibility_assignments FROM brain_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_privileged') THEN
    GRANT SELECT ON commercial_activation_gates, commercial_fee_policies,
      x402_operation_price_policies, api_commercial_tier_catalog,
      commercial_tier_prices, commercial_tier_transitions,
      commercial_billing_accounts, commercial_billing_account_tenants,
      robotmoney_entities, robotmoney_agent_instances,
      tenant_commercial_entitlements, commercial_stripe_subscriptions,
      commercial_stripe_events, api_usage_allowance_counters,
      api_usage_allowance_reservations, commercial_execution_periods,
      commercial_execution_reservations, commercial_execution_adjustments,
      commercial_charge_facts, x402_payment_operations,
      commercial_provider_commands, commercial_responsibility_assignments
      TO brain_privileged;
  END IF;
END $$;

COMMENT ON TABLE commercial_activation_gates IS
  'Commercial feature state. Every Phase 1 row is disabled and no application role may mutate it.';
COMMENT ON TABLE api_commercial_tier_catalog IS
  'Immutable RobotMoney tier revisions. Self-serve remains disabled in Phase 1.';
COMMENT ON TABLE commercial_tier_prices IS
  'Immutable localized price-book revisions. Provider references remain unset until sandbox setup.';
COMMENT ON TABLE robotmoney_entities IS
  'First-class entity scope within a tenant. Phase 1 creates no entity and enforces no entity boundary.';
COMMENT ON TABLE robotmoney_agent_instances IS
  'Commercial configured-agent projection. Runtime agent ids are cross-service references, not foreign keys.';
COMMENT ON TABLE tenant_commercial_entitlements IS
  'Commercial entitlement projection, separate from RFC 0008 request-rate tiers.';
COMMENT ON TABLE commercial_stripe_subscriptions IS
  'Stripe subscription projection only. It stores provider ids but no card data or credentials.';
COMMENT ON TABLE commercial_stripe_events IS
  'Durable Stripe webhook inbox contract. No endpoint or credential is enabled by this migration.';
COMMENT ON TABLE api_usage_allowance_reservations IS
  'Five-minute allowance reservation contract. No request-path writer is enabled in Phase 1.';
COMMENT ON TABLE commercial_execution_periods IS
  'Per-entity UTC execution-cap counters. No execution gate reads this table in Phase 1.';
COMMENT ON TABLE commercial_execution_reservations IS
  'Gross outgoing-principal reservation and settlement evidence contract.';
COMMENT ON TABLE x402_payment_operations IS
  'x402 quote, settlement, fulfillment, refund, and finality evidence without signed payload retention.';
COMMENT ON TABLE commercial_provider_commands IS
  'Provider command outbox contract. No dispatcher or provider credential exists in Phase 1.';
COMMENT ON TABLE commercial_responsibility_assignments IS
  'Stable responsibility labels assigned to Damon using his most recently active production admin actor. Later delegation changes rows, not the responsibility model.';

COMMIT;
