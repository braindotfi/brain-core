-- Bounded retry scheduling for async document extraction jobs.

BEGIN;

ALTER TABLE extraction_jobs
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

DROP INDEX IF EXISTS idx_extraction_jobs_status_created;

CREATE INDEX IF NOT EXISTS idx_extraction_jobs_status_next_attempt
  ON extraction_jobs (status, next_attempt_at, created_at);

COMMIT;
