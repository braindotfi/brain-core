-- Keep one actionable Collections proposal per overdue invoice.
--
-- Historical duplicates are repaired by the guarded operations workflow after
-- this migration is live. The runtime path serializes refreshes with an
-- advisory lock so this additive migration does not need to fail on existing
-- duplicate pending rows during deployment.

BEGIN;

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_by TEXT REFERENCES proposals(id);

UPDATE proposals
   SET updated_at = created_at
 WHERE updated_at IS NULL;

ALTER TABLE proposals
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

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
    'superseded',
    'unknown'
  ));

CREATE INDEX IF NOT EXISTS idx_proposals_collections_pending_invoice
  ON proposals (tenant_id, (action->>'invoice_id'), created_at DESC, id DESC)
  WHERE proposing_agent = 'collections'
    AND status = 'pending'
    AND action->>'type' = 'collections'
    AND action ? 'invoice_id';

COMMIT;
