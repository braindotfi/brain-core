BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS onchain_smart_account_owner TEXT,
  ADD COLUMN IF NOT EXISTS onchain_policy_registry_address TEXT;

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_onchain_smart_account_owner_check,
  ADD CONSTRAINT tenants_onchain_smart_account_owner_check
    CHECK (
      onchain_smart_account_owner IS NULL
      OR onchain_smart_account_owner ~ '^0x[0-9a-fA-F]{40}$'
    );

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_onchain_policy_registry_address_check,
  ADD CONSTRAINT tenants_onchain_policy_registry_address_check
    CHECK (
      onchain_policy_registry_address IS NULL
      OR onchain_policy_registry_address ~ '^0x[0-9a-fA-F]{40}$'
    );

COMMENT ON COLUMN tenants.onchain_smart_account_owner IS
  'Expected BrainSmartAccount owner captured at onboarding. Registry-resolved accounts must match it before dispatch.';

COMMENT ON COLUMN tenants.onchain_policy_registry_address IS
  'Expected BrainPolicyRegistry address captured at onboarding. Registry-resolved accounts must match it before dispatch.';

COMMIT;
