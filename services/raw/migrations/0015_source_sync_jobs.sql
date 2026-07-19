-- Raw source sync job status.
--
-- POST /sources/:source_id/sync returns a job id. This table makes that job
-- pollable by GET /sources/:source_id/sync/:job_id.

BEGIN;

CREATE TABLE IF NOT EXISTS raw_source_sync_jobs (
  job_id        TEXT        NOT NULL,
  tenant_id     TEXT        NOT NULL,
  source_id     TEXT        NOT NULL,
  status        TEXT        NOT NULL
                CHECK (status IN ('enqueued','running','succeeded','failed')),
  error_message TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_raw_source_sync_jobs_source
  ON raw_source_sync_jobs (tenant_id, source_id, created_at DESC);

ALTER TABLE raw_source_sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_source_sync_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY raw_source_sync_jobs_tenant_isolation
  ON raw_source_sync_jobs
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
