-- RFC 0003: durable tenant blob purge queue (GDPR Article 17 right-to-erasure).
--
-- DELETE /v1/tenants/{id} removes the DB rows but cannot, in-band, erase the
-- Raw blob bytes (Layer-1 immutability forbids a BlobAdapter hard-delete on the
-- request path). This table is the durable hand-off: tenant deletion enqueues
-- ONE row here (in the same privileged transaction as the row deletes), and a
-- privileged worker later drains it by calling BlobAdapter.purgeTenant, with
-- bounded retries + a dead-letter (exhausted) state.
--
-- CRITICAL: this table is in service.ts PRESERVED_TABLES, NOT TENANT_SCOPED_TABLES
-- — it must SURVIVE the tenant deletion (the worker processes it after the
-- tenant row is gone) and it stands as the on-record proof that erasure ran.
--
-- RLS is armed here (ENABLE) and only ENFORCED under the non-owner brain_app
-- role + FORCE ROW LEVEL SECURITY (infra/db-roles.sql, Standards §1.2). The
-- worker drains cross-tenant (the tenant is already deleted, so there is no live
-- request scope) via the brain_privileged BYPASSRLS role, exactly like the
-- outbox + webhook-dispatch workers.

CREATE TABLE IF NOT EXISTS tenant_blob_purge_jobs (
  id                TEXT        PRIMARY KEY,
  tenant_id         TEXT        NOT NULL,
  blob_prefix       TEXT        NOT NULL,              -- "<tenantId>/" (informational)
  blob_artifact_count INTEGER   NOT NULL DEFAULT 0,    -- raw_artifacts blob rows at deletion
  status            TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (status IN (
                        'pending', 'purging', 'completed', 'failed',
                        'exhausted', 'blocked_legal_hold'
                      )),
  attempts          INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_count     INTEGER,                           -- objects purged (on completion)
  legal_hold_paths  TEXT[]      NOT NULL DEFAULT '{}', -- paths NOT erased (WORM / legal hold)
  last_error        TEXT,
  locked_at         TIMESTAMPTZ,
  locked_by         TEXT,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  audit_event_ids   TEXT[]      NOT NULL DEFAULT '{}', -- lifecycle audit events
  -- One purge job per tenant: a tenant is deleted at most once, and re-enqueue
  -- (ON CONFLICT DO NOTHING) is therefore idempotent.
  UNIQUE (tenant_id)
);

ALTER TABLE tenant_blob_purge_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_blob_purge_jobs
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON tenant_blob_purge_jobs
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON tenant_blob_purge_jobs
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- Claim index: the worker selects due, not-yet-terminal jobs oldest-first.
CREATE INDEX IF NOT EXISTS idx_tenant_blob_purge_due
  ON tenant_blob_purge_jobs (next_attempt_at)
  WHERE status IN ('pending', 'failed');
