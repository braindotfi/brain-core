-- Add the `identity` audit layer (RFC 0002 self-serve onboarding).
--
-- Tenant/user provisioning, email verification, human login, and wallet linking
-- are identity-layer events — they don't belong to any of the existing six
-- protocol layers. They must still be audited (Principle #4), so the audit_events
-- layer CHECK is broadened to admit 'identity'.
--
-- Forward-compatible: only widens the CHECK; every existing row still satisfies.

BEGIN;

-- Drop the current layer CHECK (whatever its generated name) and re-add it with
-- 'identity' included. Mirrors the 0003 broaden-the-enum pattern.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT conname INTO con_name
    FROM pg_constraint
   WHERE conrelid = 'audit_events'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%layer%raw%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE audit_events DROP CONSTRAINT %I', con_name);
  END IF;
END$$;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_layer_v0_4_check
  CHECK (layer IN ('raw', 'ledger', 'wiki', 'policy', 'execution', 'agent', 'audit', 'identity'));

COMMIT;
