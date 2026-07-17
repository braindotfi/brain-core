-- Customer-facing proposal decision statuses.
--
-- /v1/proposals/{id}/decide can acknowledge notify-only proposals and undo an
-- approved, not-yet-executed non-money proposal. The read surface also exposes
-- reconciling and unknown as client-facing safety states.

BEGIN;

DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT conname INTO con_name
    FROM pg_constraint
   WHERE conrelid = 'proposals'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%status%pending%approved%rejected%executed%failed%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE proposals DROP CONSTRAINT %I', con_name);
  END IF;
END$$;

ALTER TABLE proposals
  ADD CONSTRAINT proposals_status_decision_check
  CHECK (status IN (
    'pending',
    'approved',
    'acknowledged',
    'reconciling',
    'rejected',
    'executed',
    'failed',
    'undone',
    'unknown'
  ));

COMMIT;
