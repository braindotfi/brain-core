-- RFC 0003 hardening (2026-06-07 review P2 #1): make purge-lifecycle auditing
-- transactional.
--
-- The worker used to emit the lifecycle audit event BEFORE the DB status write,
-- and on an audit-emit failure stored the literal sentinel 'audit-emit-failed'
-- and completed the job anyway. So a DB failure could orphan a "completed" audit
-- event while the job stayed 'purging', and an audit outage produced a job with
-- no real audit event — both violations of "if it is not in the log, it did not
-- happen" (Standards §1.4).
--
-- This outbox is the fix: each job state transition writes its audit INTENT here
-- in the SAME transaction as the status change (atomic — neither can exist
-- without the other), and a publisher delivers the event to the audit service
-- asynchronously, idempotently (UNIQUE event_key), recording the real
-- audit_event_id. A tenant deletion / state transition therefore returns a
-- truthful committed result even if the audit service is momentarily down.
--
-- Like tenant_blob_purge_jobs, this table belongs to ALREADY-DELETED tenants and
-- is drained cross-tenant by the privileged (BYPASSRLS) worker; RLS is armed for
-- symmetry and only enforced under the non-owner brain_app role.

CREATE TABLE IF NOT EXISTS tenant_blob_purge_audit_outbox (
  id              TEXT        PRIMARY KEY,
  job_id          TEXT        NOT NULL,
  tenant_id       TEXT        NOT NULL,
  action          TEXT        NOT NULL,                  -- e.g. tenant_blob.purge_completed
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Deterministic idempotency key ("<job_id>:<action>:<attempt>"): a logical
  -- lifecycle event is enqueued at most once even across worker reclaims /
  -- retries (INSERT ... ON CONFLICT (event_key) DO NOTHING).
  event_key       TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'published')),
  audit_event_id  TEXT,                                  -- real id, set on delivery
  attempts        INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ,
  UNIQUE (event_key)
);

ALTER TABLE tenant_blob_purge_audit_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_blob_purge_audit_outbox
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON tenant_blob_purge_audit_outbox
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON tenant_blob_purge_audit_outbox
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- Publisher claim index: drain pending rows oldest-first.
CREATE INDEX IF NOT EXISTS idx_tenant_blob_purge_outbox_pending
  ON tenant_blob_purge_audit_outbox (next_attempt_at)
  WHERE status = 'pending';
