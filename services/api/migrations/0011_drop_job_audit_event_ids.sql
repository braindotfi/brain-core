-- RFC 0003 hardening (2026-06-07 audit-subsystem review P2): drop the
-- misnamed `audit_event_ids` array from tenant_blob_purge_jobs.
--
-- The column was named for audit event ids but the mark* transitions appended
-- the deterministic OUTBOX event_key, not a real evt_... id (the real id is only
-- known after the audit publisher delivers the row). Nothing reads the column,
-- and the job -> audit relationship is now normalized: the outbox table carries
-- (job_id, event_key, audit_event_id-after-publish) for every lifecycle event.
-- So the array is redundant + misleading; remove it.

ALTER TABLE tenant_blob_purge_jobs
  DROP COLUMN IF EXISTS audit_event_ids;
