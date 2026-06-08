-- Codex 307161b P1 #2: durable audit-integrity findings.
--
-- The cursor verifier reported a content-hash mismatch via a per-PAGE gauge that
-- resets to zero on the next clean page, so a real tamper could silently appear
-- resolved. A detected mismatch must instead create a DURABLE, append-oriented
-- finding that stays OPEN until an operator explicitly resolves it, and a sticky
-- open-count keeps the ledger from being represented as healthy meanwhile.
--
-- Verifier state, not tenant data: no RLS (only the privileged verifier writes).

CREATE TABLE IF NOT EXISTS audit_integrity_findings (
  id                   TEXT        PRIMARY KEY,
  event_id             TEXT        NOT NULL,
  tenant_id            TEXT        NOT NULL,
  verifier_name        TEXT        NOT NULL,
  hash_schema_version  SMALLINT    NOT NULL,
  -- expected = recomputed from the persisted logical fields; observed = stored.
  expected_hash        BYTEA       NOT NULL,
  observed_hash        BYTEA       NOT NULL,
  detected_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  status               TEXT        NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'resolved')),
  resolved_at          TIMESTAMPTZ,
  resolution_actor     TEXT,
  resolution_reference TEXT
);

-- At most one OPEN finding per (verifier, event): a repeated detection of the
-- same break does not pile up duplicates (ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_integrity_finding_open
  ON audit_integrity_findings (verifier_name, event_id)
  WHERE status = 'open';

-- Surface the most recent failed cycle on the cursor row itself.
ALTER TABLE audit_verifier_checkpoint
  ADD COLUMN IF NOT EXISTS last_failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE audit_verifier_checkpoint
  ADD COLUMN IF NOT EXISTS last_failed_at TIMESTAMPTZ;
