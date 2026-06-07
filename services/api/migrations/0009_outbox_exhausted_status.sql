-- RFC 0003 hardening (2026-06-07 audit-subsystem review P1): give the audit
-- outbox an explicit `exhausted` state.
--
-- The publisher claim selects rows with attempts < MAX_OUTBOX_PUBLISH_ATTEMPTS.
-- Before this change, a row that failed delivery that many times stayed
-- `pending` but was no longer claimable — silently invisible mandatory audit
-- evidence, with no alert and no replay path. That can leave a completed erasure
-- without its promised lifecycle audit record.
--
-- The off-chain change (blob-purge-audit-outbox.ts) transitions such a row to a
-- terminal `exhausted` state (with a critical metric), and an operator replay
-- resets it to `pending`. This migration widens the status CHECK to allow it.

ALTER TABLE tenant_blob_purge_audit_outbox
  DROP CONSTRAINT IF EXISTS tenant_blob_purge_audit_outbox_status_check;

ALTER TABLE tenant_blob_purge_audit_outbox
  ADD CONSTRAINT tenant_blob_purge_audit_outbox_status_check
  CHECK (status IN ('pending', 'published', 'exhausted'));

-- Observability: surface exhausted rows (outstanding mandatory audit evidence)
-- for an operator query / readiness check.
CREATE INDEX IF NOT EXISTS idx_tenant_blob_purge_outbox_exhausted
  ON tenant_blob_purge_audit_outbox (created_at)
  WHERE status = 'exhausted';
