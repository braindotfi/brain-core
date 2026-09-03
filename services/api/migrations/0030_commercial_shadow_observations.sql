-- RFC 0011 Phase 2: observe-only commercial limit evaluation.
-- The schema records counterfactual outcomes and cannot apply enforcement.

BEGIN;

CREATE TABLE IF NOT EXISTS commercial_shadow_periods (
  id                    TEXT        PRIMARY KEY,
  started_at            TIMESTAMPTZ NOT NULL,
  minimum_days          INTEGER     NOT NULL DEFAULT 30 CHECK (minimum_days >= 30),
  completed_at          TIMESTAMPTZ,
  reviewed_at           TIMESTAMPTZ,
  reviewed_by           TEXT,
  review_outcome        TEXT        CHECK (review_outcome IN ('accepted', 'extend', 'rejected')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (completed_at IS NULL OR completed_at >= started_at + (minimum_days * interval '1 day')),
  CHECK (
    reviewed_at IS NULL
    OR (completed_at IS NOT NULL AND reviewed_by IS NOT NULL AND review_outcome IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS commercial_shadow_observations (
  id                    TEXT        NOT NULL,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shadow_period_id      TEXT        NOT NULL REFERENCES commercial_shadow_periods(id),
  catalog_revision_id   TEXT        REFERENCES api_commercial_tier_catalog(id),
  catalog_resolution    TEXT        NOT NULL CHECK (catalog_resolution IN ('explicit', 'unresolved')),
  entity_count          INTEGER     NOT NULL CHECK (entity_count >= 0),
  counted_agent_count   INTEGER     NOT NULL CHECK (counted_agent_count >= 0),
  execution_settled_minor_units BIGINT NOT NULL CHECK (execution_settled_minor_units >= 0),
  execution_reserved_minor_units BIGINT NOT NULL CHECK (execution_reserved_minor_units >= 0),
  execution_currency    TEXT        NOT NULL DEFAULT 'USD' CHECK (execution_currency = 'USD'),
  entity_capacity_result TEXT       NOT NULL CHECK (entity_capacity_result IN ('within', 'over', 'unresolved')),
  agent_capacity_result TEXT        NOT NULL CHECK (agent_capacity_result IN ('within', 'over', 'unresolved')),
  execution_limit_result TEXT       NOT NULL CHECK (execution_limit_result IN ('within', 'over', 'unresolved')),
  divergence_codes      TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  evidence              JSONB       NOT NULL,
  enforcement_applied   BOOLEAN     NOT NULL DEFAULT FALSE CHECK (enforcement_applied = FALSE),
  observed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_commercial_shadow_observations_period
  ON commercial_shadow_observations (shadow_period_id, observed_at, tenant_id);

ALTER TABLE commercial_shadow_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_shadow_observations FORCE ROW LEVEL SECURITY;

CREATE POLICY commercial_shadow_observations_tenant_read ON commercial_shadow_observations
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY commercial_shadow_observations_tenant_insert ON commercial_shadow_observations
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_shadow_periods,
  commercial_shadow_observations FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    GRANT SELECT ON commercial_shadow_periods, commercial_shadow_observations TO brain_app;
    GRANT INSERT ON commercial_shadow_observations TO brain_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_privileged') THEN
    GRANT SELECT, INSERT, UPDATE ON commercial_shadow_periods TO brain_privileged;
    GRANT SELECT, INSERT ON commercial_shadow_observations TO brain_privileged;
  END IF;
END $$;

COMMENT ON TABLE commercial_shadow_periods IS
  'Explicit minimum-30-day observe-only windows. Completion and review are separate recorded events.';
COMMENT ON TABLE commercial_shadow_observations IS
  'Counterfactual catalog, entity, agent, and execution-limit outcomes. The database forbids enforcement_applied=true.';

COMMIT;
