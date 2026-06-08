-- Codex 9389568 P2: distinguish a CLEAN full pass from a failed one.
--
-- The cursor verifier bumped completed_passes + last_full_pass_at on every wrap
-- and recorded only a per-PAGE last_failure_count, so "a full pass completed"
-- could not be told apart from "a full pass completed AND every page was clean".
-- A pass that found a mismatch on an early page still advanced last_full_pass_at,
-- making the chain look freshly verified-good. These columns accumulate mismatches
-- across every page of a pass and record the clean/failed outcome separately, so
-- "time since the last CLEAN full pass" becomes observable.

ALTER TABLE audit_verifier_checkpoint
  ADD COLUMN IF NOT EXISTS current_pass_failure_count BIGINT NOT NULL DEFAULT 0;
ALTER TABLE audit_verifier_checkpoint
  ADD COLUMN IF NOT EXISTS last_pass_status TEXT NOT NULL DEFAULT 'never'
    CHECK (last_pass_status IN ('never', 'clean', 'failed'));
ALTER TABLE audit_verifier_checkpoint
  ADD COLUMN IF NOT EXISTS last_clean_pass_at TIMESTAMPTZ;
ALTER TABLE audit_verifier_checkpoint
  ADD COLUMN IF NOT EXISTS last_failed_pass_at TIMESTAMPTZ;
