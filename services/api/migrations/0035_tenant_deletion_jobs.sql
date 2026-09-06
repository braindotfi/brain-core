ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS do_not_delete BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE tenants
   SET do_not_delete = TRUE,
       updated_at = now()
 WHERE id IN (
  'tnt_00000000010000000000000000',
  'tnt_01KYAT7A1QRKHTYW9H4RAR2SEX',
  'tnt_01KYAT31JH0G043K77H8SKYG4N',
  'tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ',
  'tnt_01M1GTBQN8R8PB6X6PN73YB6NP',
  'tnt_01M1M64ZE1R8J9TB6C3DCRKA61'
 );

CREATE TABLE IF NOT EXISTS tenant_deletion_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'fencing', 'deleting', 'purging_blobs', 'completed', 'failed')),
  expected_rows JSONB,
  deleted_rows JSONB,
  total_rows_deleted BIGINT,
  blob_purge_job_id TEXT,
  blob_artifact_count INTEGER,
  agent_state_snapshot JSONB,
  last_error TEXT,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_deletion_jobs_claim
  ON tenant_deletion_jobs (status, created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_tenant_deletion_jobs_requester
  ON tenant_deletion_jobs (requested_by, id);

ALTER TABLE tenant_deletion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_deletion_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_deletion_jobs_tenant_isolation ON tenant_deletion_jobs;
CREATE POLICY tenant_deletion_jobs_tenant_isolation
  ON tenant_deletion_jobs
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMENT ON TABLE tenant_deletion_jobs IS
  'Durable asynchronous tenant deletion jobs. Rows survive tenant deletion as erasure evidence.';
COMMENT ON COLUMN tenants.do_not_delete IS
  'Fail-closed operator protection from every tenant deletion path.';
