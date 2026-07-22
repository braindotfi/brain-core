-- Bounded retry scheduling for the interpretation worker (Appendix B mechanism 2).
--
-- The worker previously polled `NOT EXISTS (... raw_interpretation_log ...)`,
-- and the failure path wrote a log row via `ON CONFLICT DO NOTHING`. That
-- combination meant a transient failure (a blob read blip, a DB hiccup)
-- permanently stranded the artifact: the log row written to record the
-- error also satisfied the NOT EXISTS exclusion, so no later cycle would
-- ever retry it, and a subsequent success could never overwrite the failure
-- row. This adds the same bounded-exponential-backoff columns the async
-- document extraction path already uses (extraction_jobs.next_attempt_at,
-- 0014_extraction_job_retry.sql) so both retry mechanisms share one shape.

BEGIN;

ALTER TABLE raw_interpretation_log
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE raw_interpretation_log
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

COMMIT;
