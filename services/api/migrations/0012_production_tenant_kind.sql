-- Production tenancy contract: tenants are explicitly demo or production.
--
-- Existing tenants predate this contract and are therefore backfilled as demo.
-- The kind is immutable after creation so a demo tenant cannot be promoted into
-- production by updating a row in place.

BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'demo';

UPDATE tenants SET kind = 'demo' WHERE kind IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'tenants_kind_check'
       AND conrelid = 'tenants'::regclass
  ) THEN
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_kind_check CHECK (kind IN ('production', 'demo'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION prevent_tenant_kind_update()
RETURNS trigger AS $$
BEGIN
  IF OLD.kind IS DISTINCT FROM NEW.kind THEN
    RAISE EXCEPTION 'tenant.kind is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenants_kind_immutable ON tenants;
CREATE TRIGGER tenants_kind_immutable
  BEFORE UPDATE ON tenants
  FOR EACH ROW
  EXECUTE FUNCTION prevent_tenant_kind_update();

COMMENT ON COLUMN tenants.kind IS
  'Production tenancy discriminator: production | demo. Immutable after insert; existing rows backfill demo.';

COMMIT;
