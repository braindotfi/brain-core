-- Add bounded retry and quarantine state for legacy Ledger normalization.
-- A failed row is retried until attempts reaches the worker's retry budget;
-- successful and quarantined rows are terminal for the poll query.

BEGIN;

ALTER TABLE normalization_log
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quarantined BOOLEAN NOT NULL DEFAULT false;

UPDATE normalization_log
   SET attempts = 1
 WHERE error IS NOT NULL
   AND attempts = 0;

CREATE INDEX IF NOT EXISTS idx_normalization_log_pending
  ON normalization_log (raw_parsed_id, error, quarantined);

COMMIT;
