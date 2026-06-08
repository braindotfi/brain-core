-- Codex fca9ac8 P1 #2: durable cursor for content-hash verification.
--
-- The consistency verifier recomputes each event's canonical hash and compares
-- it to the stored event_hash. A bounded "newest-N" scan never reaches older
-- events; this checkpoint lets the verifier page through EVERY current-version
-- event in stable (created_at, id) order across cycles, advance transactionally,
-- and wrap to the beginning after a full pass.
--
-- This is verifier state, not tenant data: a single row per verifier, no
-- tenant_id, no RLS. Only the privileged verifier reads/writes it.

CREATE TABLE IF NOT EXISTS audit_verifier_checkpoint (
  verifier_name       TEXT        PRIMARY KEY,
  -- The schema version this cursor is paging through; a version bump resets it.
  hash_schema_version SMALLINT    NOT NULL,
  -- Keyset position (NULL = start of a fresh pass).
  last_created_at     TIMESTAMPTZ,
  last_event_id       TEXT,
  -- Observability: how many full passes have completed and when the last ended.
  completed_passes    BIGINT      NOT NULL DEFAULT 0,
  last_full_pass_at   TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
