-- Durable, server-owned eligibility markers for synthetic demo API keys.
--
-- Existing tenants remain unclassified because the prior schema cannot prove
-- how their data was provisioned. They do not become eligible for Raw API-key
-- scopes merely because they predate this migration. Trusted provisioning sets
-- the markers explicitly and only reaches ready_demo after its seeder succeeds.

BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS provisioning_state TEXT,
  ADD COLUMN IF NOT EXISTS data_profile TEXT,
  ADD COLUMN IF NOT EXISTS access_stage TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'tenants_provisioning_state_check'
       AND conrelid = 'tenants'::regclass
  ) THEN
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_provisioning_state_check
      CHECK (
        provisioning_state IS NULL
        OR provisioning_state IN ('provisioning', 'ready_demo', 'seed_failed', 'archived')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'tenants_data_profile_check'
       AND conrelid = 'tenants'::regclass
  ) THEN
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_data_profile_check
      CHECK (
        data_profile IS NULL
        OR data_profile IN ('synthetic_brightline_v1', 'customer')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'tenants_access_stage_check'
       AND conrelid = 'tenants'::regclass
  ) THEN
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_access_stage_check
      CHECK (
        access_stage IS NULL
        OR access_stage IN ('demo', 'production_review', 'production')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'tenants_ready_demo_classification_check'
       AND conrelid = 'tenants'::regclass
  ) THEN
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_ready_demo_classification_check
      CHECK (
        provisioning_state <> 'ready_demo'
        OR (
          data_profile = 'synthetic_brightline_v1'
          AND access_stage = 'demo'
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN tenants.provisioning_state IS
  'Trusted provisioning state. ready_demo is required for synthetic sandbox Raw API keys.';
COMMENT ON COLUMN tenants.data_profile IS
  'Server-owned data classification: customer or synthetic_brightline_v1. Null means unclassified legacy data.';
COMMENT ON COLUMN tenants.access_stage IS
  'Server-owned access stage: demo, production_review, or production. Null means unclassified legacy data.';

COMMIT;
