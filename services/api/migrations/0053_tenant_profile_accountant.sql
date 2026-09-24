BEGIN;

ALTER TABLE tenant_profiles
  ADD COLUMN IF NOT EXISTS accountant JSONB;

ALTER TABLE tenant_profiles
  ADD CONSTRAINT tenant_profiles_accountant_shape CHECK (
    accountant IS NULL OR (
      jsonb_typeof(accountant) = 'object'
      AND jsonb_typeof(accountant->'name') = 'string'
      AND jsonb_typeof(accountant->'org') = 'string'
      AND jsonb_typeof(accountant->'email') = 'string'
    )
  ) NOT VALID;

ALTER TABLE tenant_profiles
  VALIDATE CONSTRAINT tenant_profiles_accountant_shape;

COMMIT;
