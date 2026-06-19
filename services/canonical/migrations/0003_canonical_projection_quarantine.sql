-- Canonical projection poison-message handling (RFC 0005, follow-up).
--
-- Before this migration a raw_parsed row that failed projection got a single
-- canonical_projection_log row with `error` set and was then never re-polled:
-- one transient failure (a deadlock, an FK race, a momentary DB blip) silently
-- and permanently dropped an otherwise-good record, with no metric and no way
-- to replay it. There were no retries and no observable quarantine.
--
-- This adds a bounded retry budget plus an explicit quarantine flag:
--   * `attempts`    — how many times projection has failed for this row.
--   * `quarantined` — set once the retry budget is exhausted; the row is then
--                     moved aside so the lane keeps projecting siblings, and
--                     surfaced via brain.canonical.projector.quarantine.* metrics.
-- A failed-but-not-quarantined row (error set, quarantined = false) is re-polled
-- on the next cycle. A quarantined row is excluded until an operator replays it
-- (replayQuarantined resets quarantined + attempts). A successful projection
-- writes error = NULL / quarantined = false and is terminal as before.

BEGIN;

ALTER TABLE canonical_projection_log
  ADD COLUMN IF NOT EXISTS attempts    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quarantined BOOLEAN NOT NULL DEFAULT false;

-- Partial index: the quarantine-depth gauge and the replay/drain only scan the
-- (expected small) quarantined set, never the full consumed log.
CREATE INDEX IF NOT EXISTS idx_canonical_projection_log_quarantined
  ON canonical_projection_log (tenant_id)
  WHERE quarantined = true;

COMMIT;
