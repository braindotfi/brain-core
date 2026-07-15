-- Rename H-09 contribution quarantine metadata to contribution hold.
-- The agent lifecycle state `quarantined` remains unchanged for the kill switch.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'agents'
       AND column_name = 'quarantine_cleared_at'
  ) AND NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'agents'
       AND column_name = 'contribution_hold_cleared_at'
  ) THEN
    ALTER TABLE agents
      RENAME COLUMN quarantine_cleared_at TO contribution_hold_cleared_at;
  END IF;
END $$;

