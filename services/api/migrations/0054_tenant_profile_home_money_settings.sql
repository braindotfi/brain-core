BEGIN;

ALTER TABLE tenant_profiles
  ADD COLUMN IF NOT EXISTS operating_account_id TEXT,
  ADD COLUMN IF NOT EXISTS net_burn_per_day NUMERIC(28, 8);

ALTER TABLE tenant_profiles
  ADD CONSTRAINT tenant_profiles_net_burn_per_day_nonnegative CHECK (
    net_burn_per_day IS NULL OR net_burn_per_day >= 0
  ) NOT VALID;

ALTER TABLE tenant_profiles
  VALIDATE CONSTRAINT tenant_profiles_net_burn_per_day_nonnegative;

COMMIT;
