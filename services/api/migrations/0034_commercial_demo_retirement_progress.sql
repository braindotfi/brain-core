CREATE TABLE IF NOT EXISTS commercial_demo_retirement_progress (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  candidate_list_sha256 TEXT NOT NULL
    CHECK (candidate_list_sha256 ~ '^[0-9a-f]{64}$'),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  expected_rows JSONB NOT NULL,
  deleted_rows JSONB,
  total_rows_deleted BIGINT,
  blob_purge_job_id TEXT,
  blob_artifact_count INTEGER,
  first_started_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  committed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, tenant_id),
  UNIQUE (operation_id, ordinal)
);

ALTER TABLE commercial_demo_retirement_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_demo_retirement_progress FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commercial_demo_retirement_progress_tenant_isolation
  ON commercial_demo_retirement_progress;
CREATE POLICY commercial_demo_retirement_progress_tenant_isolation
  ON commercial_demo_retirement_progress
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMENT ON TABLE commercial_demo_retirement_progress IS
  'Durable, resumable progress for the approved one-time commercial demo retirement.';
