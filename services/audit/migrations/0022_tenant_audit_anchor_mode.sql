-- Audit anchoring mode is explicit per tenant. Demo data remains protected by
-- the database audit hash chain but is never submitted to Base Sepolia.
--
-- This belongs after audit_events in the global migration order because the
-- historical durable-demo backfill is identified by tenant.demo_seeded.

BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS audit_anchor_mode TEXT NOT NULL DEFAULT 'onchain';

UPDATE tenants
   SET audit_anchor_mode = 'db_only'
 WHERE kind = 'demo'
    OR sandbox = TRUE
    OR EXISTS (
      SELECT 1
        FROM audit_events e
       WHERE e.tenant_id = tenants.id
         AND e.action = 'tenant.demo_seeded'
    );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'tenants_audit_anchor_mode_check'
       AND conrelid = 'tenants'::regclass
  ) THEN
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_audit_anchor_mode_check
      CHECK (audit_anchor_mode IN ('onchain', 'db_only'));
  END IF;
END $$;

COMMENT ON COLUMN tenants.audit_anchor_mode IS
  'onchain publishes tenant Merkle roots to Base Sepolia; db_only keeps the immutable database hash chain without on-chain publication. Demo and sandbox tenants are db_only.';

-- The cross-tenant verifier and publisher now explicitly join tenants to
-- exclude db_only rows. Fresh environments receive the same grants from
-- infra/db-roles.sql; this fixes the already-provisioned production roles.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'brain_audit_verifier') THEN
    EXECUTE 'GRANT SELECT ON tenants TO brain_audit_verifier';
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'brain_audit_publisher') THEN
    EXECUTE 'GRANT SELECT ON tenants TO brain_audit_publisher';
  END IF;
END
$$;

COMMIT;
