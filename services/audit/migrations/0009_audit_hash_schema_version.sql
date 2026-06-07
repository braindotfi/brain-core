-- Codex c96283d P1 #2: content-hash verification.
--
-- Tag every audit event with the canonical-hash schema version that produced
-- its event_hash. The consistency verifier recomputes the canonical hash and
-- compares it to the stored event_hash, but only for rows at the CURRENT
-- version, so it never flags older rows written under a superseded
-- serialization (e.g. the pre-BYTEA-fix Buffer form). 0 = "pre-versioning":
-- existing rows default to it and the verifier skips them; the emitter writes
-- the current version for every new event.

ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS hash_schema_version SMALLINT NOT NULL DEFAULT 0;

-- Partial index over current-version rows so the verifier's bounded scan stays
-- cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_audit_events_hash_schema_version
  ON audit_events (hash_schema_version, created_at DESC, id DESC)
  WHERE hash_schema_version > 0;
