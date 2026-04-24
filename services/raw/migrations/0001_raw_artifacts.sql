-- Brain raw_artifacts table.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 1.
-- Owner: services/raw.

BEGIN;

CREATE TABLE IF NOT EXISTS raw_artifacts (
  id              TEXT        PRIMARY KEY,                  -- Brain ULID: raw_...
  tenant_id       TEXT        NOT NULL,                     -- tnt_...
  sha256          BYTEA       NOT NULL,                     -- content address, 32 bytes
  source_type     TEXT        NOT NULL
                  CHECK (source_type IN (
                    'plaid','erp_netsuite','email','upload','chain_evm',
                    'stripe','agent_contributed','other'
                  )),
  source_ref      JSONB       NOT NULL DEFAULT '{}'::jsonb, -- source-specific identifiers
  blob_uri        TEXT        NOT NULL,                     -- per-tenant blob path
  mime_type       TEXT,
  bytes           BIGINT      NOT NULL CHECK (bytes >= 0),
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  tombstoned_at   TIMESTAMPTZ,                              -- NULL = live
  ingested_by     TEXT        NOT NULL,                     -- principal id (user/agent/partner)
  UNIQUE (tenant_id, sha256)                                -- §3 Layer 1 content-address dedup
);

CREATE INDEX IF NOT EXISTS idx_raw_artifacts_tenant_ingested_at
  ON raw_artifacts (tenant_id, ingested_at DESC);

CREATE INDEX IF NOT EXISTS idx_raw_artifacts_tenant_source
  ON raw_artifacts (tenant_id, source_type);

-- §1 principle 2: tenant isolation via RLS. Queries without app.tenant_id set
-- see nothing.
ALTER TABLE raw_artifacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON raw_artifacts
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_write ON raw_artifacts
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_update ON raw_artifacts
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
