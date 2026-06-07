-- RFC 0003 hardening (2026-06-07 audit-subsystem review P1): let the audit
-- outbox carry the deletion-endpoint's own lifecycle events, not just the purge
-- worker's transitions.
--
-- service.ts emitted `tenant.deleted` and `tenant_blob.purge_requested` AFTER the
-- deletion transaction committed (fire-after-commit): a crash or audit outage in
-- that window left a committed deletion with no durable audit intent, and could
-- make a committed deletion return an error. The fix enqueues those events into
-- the deletion transaction via this outbox.
--
-- Those events need their own actor (the requester, not the worker) and inputs,
-- and `tenant.deleted` has no purge job — so:
--   - add `actor` (delivery falls back to the worker id when null, preserving the
--     existing purge-lifecycle rows);
--   - add `inputs` (merged into the delivered event's inputs);
--   - make `job_id` nullable (a tenant deleted with no blobs has no purge job).

ALTER TABLE tenant_blob_purge_audit_outbox
  ADD COLUMN IF NOT EXISTS actor TEXT;

ALTER TABLE tenant_blob_purge_audit_outbox
  ADD COLUMN IF NOT EXISTS inputs JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE tenant_blob_purge_audit_outbox
  ALTER COLUMN job_id DROP NOT NULL;
