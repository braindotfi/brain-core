-- Add the `canonical` audit layer (ingestion architecture §12, Phase 5).
--
-- The canonical domain layer (services/canonical) projects rich, versioned
-- domain records from raw_parsed; those writes must be audited (Principle #4),
-- and they are neither Raw nor Ledger events. The audit_events layer CHECK is
-- broadened to admit 'canonical'.
--
-- Forward-compatible: only widens the CHECK; every existing row still satisfies.

BEGIN;

-- Drop the current layer CHECK (whatever its generated name) and re-add it with
-- 'canonical' included. Mirrors the 0003 / 0005 broaden-the-enum pattern.
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
  ADD CONSTRAINT audit_events_layer_v0_5_check
  CHECK (layer IN ('raw', 'canonical', 'ledger', 'wiki', 'policy', 'execution', 'agent', 'audit', 'identity'));

COMMIT;
