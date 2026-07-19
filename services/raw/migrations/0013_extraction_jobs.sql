-- Async document extraction jobs and tenant opt-in setting.
-- Owner: services/raw.

BEGIN;

CREATE TABLE IF NOT EXISTS raw_tenant_settings (
  tenant_id              TEXT        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  auto_extract_documents BOOLEAN     NOT NULL DEFAULT false,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE raw_tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_tenant_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY raw_tenant_settings_isolation ON raw_tenant_settings
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY raw_tenant_settings_write ON raw_tenant_settings
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY raw_tenant_settings_update ON raw_tenant_settings
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS extraction_jobs (
  id             TEXT        PRIMARY KEY,
  tenant_id      TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  raw_id         TEXT        NOT NULL REFERENCES raw_artifacts(id) ON DELETE RESTRICT,
  content_sha256 BYTEA       NOT NULL,
  status         TEXT        NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  parsed_id      TEXT        REFERENCES raw_parsed(id) ON DELETE SET NULL,
  confidence     DOUBLE PRECISION CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  error          JSONB,
  attempt_count  INTEGER     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  requested_by   TEXT,
  locked_at      TIMESTAMPTZ,
  locked_by      TEXT,
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, raw_id, content_sha256)
);

CREATE INDEX IF NOT EXISTS idx_extraction_jobs_status_created
  ON extraction_jobs (status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_extraction_jobs_tenant_raw_created
  ON extraction_jobs (tenant_id, raw_id, created_at DESC);

ALTER TABLE extraction_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY extraction_jobs_isolation ON extraction_jobs
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY extraction_jobs_write ON extraction_jobs
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY extraction_jobs_update ON extraction_jobs
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
