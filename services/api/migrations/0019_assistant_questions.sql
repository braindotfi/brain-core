BEGIN;

CREATE TABLE IF NOT EXISTS assistant_questions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'suggested'
    CHECK (status IN ('suggested', 'answered', 'dismissed')),
  source TEXT,
  evidence_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_questions_tenant_created_idx
  ON assistant_questions (tenant_id, created_at DESC, id DESC);

ALTER TABLE assistant_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_questions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS assistant_questions_tenant_isolation ON assistant_questions;
CREATE POLICY assistant_questions_tenant_isolation
  ON assistant_questions
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMENT ON TABLE assistant_questions IS
  'Tenant-scoped suggested or answered assistant questions surfaced to clients.';

COMMIT;
