-- Fable-5 review F-1: stop the audit-health endpoint scanning audit_events.
--
-- reportVerifierHealth counted unsupported (> current) and legacy (< current)
-- hash_schema_version rows with a FILTER aggregate over audit_events on EVERY
-- GET /internal/audit/health request. The 0009 index is PARTIAL
-- (WHERE hash_schema_version > 0), so the legacy side cannot use it and the
-- combined FILTER form uses no index at all: every health poll was a full
-- sequential scan of the largest table in the system.
--
-- The verifier cycle already computes both counts every interval; persist them
-- on the checkpoint row so the endpoint reads a single small row instead. The
-- endpoint's counts are therefore as-of the last verifier cycle (staleness
-- bounded by the verifier interval, default 10 minutes) — the right freshness
-- for a health surface, and the verifier's own cycle-cadence scan is the same
-- cost class as the structural fork/gap checks that already run each cycle.

ALTER TABLE audit_verifier_checkpoint
  ADD COLUMN IF NOT EXISTS unsupported_version_count BIGINT NOT NULL DEFAULT 0;
ALTER TABLE audit_verifier_checkpoint
  ADD COLUMN IF NOT EXISTS legacy_unverifiable_count BIGINT NOT NULL DEFAULT 0;
