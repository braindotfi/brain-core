-- BC-9: async tenant data export jobs (GDPR Article 20 portability).
--
-- Exports are sensitive tenant archives. The request route is user-principal
-- and own-tenant only, and the worker assembles data through tenant-scoped
-- reads. Jobs are deleted with the tenant during Article 17 erasure.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_export_jobs (
  id              TEXT        PRIMARY KEY,
  tenant_id       TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status          TEXT        NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','succeeded','failed')),
  output_blob_uri TEXT,
  byte_size       BIGINT,
  expires_at      TIMESTAMPTZ NOT NULL,
  error           JSONB,
  requested_by    TEXT        NOT NULL,
  locked_at       TIMESTAMPTZ,
  locked_by       TEXT,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  purged_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_export_jobs_inflight
  ON tenant_export_jobs (tenant_id)
  WHERE status IN ('queued','running');

CREATE INDEX IF NOT EXISTS idx_tenant_export_jobs_status_created
  ON tenant_export_jobs (status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_tenant_export_jobs_expired
  ON tenant_export_jobs (expires_at ASC)
  WHERE status = 'succeeded' AND output_blob_uri IS NOT NULL AND purged_at IS NULL;

ALTER TABLE tenant_export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_export_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_export_jobs_isolation ON tenant_export_jobs
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_export_jobs_write ON tenant_export_jobs
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_export_jobs_update ON tenant_export_jobs
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
