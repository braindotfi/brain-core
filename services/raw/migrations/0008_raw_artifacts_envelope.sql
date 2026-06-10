-- Brain Raw -- standard ingestion envelope columns (ingestion architecture §9).
--
-- Every accepted artifact may carry a declared source schema, the three
-- distinct timestamps (effective_at / observed_at / ingested_at), the visible
-- source chain (original_source + intermediaries), the provider object
-- coordinates (object_type, external_id, operation, source_version), a link
-- to the producing connection (source_id -> raw_sources.id, soft reference,
-- no FK: connections may be deleted independently of evidence), and a caller
-- idempotency key.
--
-- All columns are nullable: the envelope is additive and every existing
-- ingestion path keeps working unchanged. Intake stores these as opaque
-- declarations and never parses the payload against source_schema.
--
-- Idempotency: content-hash dedup (UNIQUE (tenant_id, sha256), raw/0001)
-- remains the intrinsic guard; the partial unique index on idempotency_key
-- adds the envelope-level guard ("connection:resource:object:version") so a
-- provider re-send with cosmetically different bytes still dedups.

BEGIN;

ALTER TABLE raw_artifacts
  ADD COLUMN IF NOT EXISTS source_schema   TEXT,
  ADD COLUMN IF NOT EXISTS object_type     TEXT,
  ADD COLUMN IF NOT EXISTS external_id     TEXT,
  ADD COLUMN IF NOT EXISTS operation       TEXT
    CHECK (operation IS NULL OR operation IN ('upsert','delete','snapshot')),
  ADD COLUMN IF NOT EXISTS effective_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS observed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS original_source TEXT,
  ADD COLUMN IF NOT EXISTS intermediaries  JSONB,
  ADD COLUMN IF NOT EXISTS source_id       TEXT,
  ADD COLUMN IF NOT EXISTS source_version  TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Parser pickup by declared schema (interpretation workers poll this).
CREATE INDEX IF NOT EXISTS idx_raw_artifacts_tenant_schema
  ON raw_artifacts (tenant_id, source_schema)
  WHERE source_schema IS NOT NULL;

-- Sync-partition lookups: which object states has this connection landed?
CREATE INDEX IF NOT EXISTS idx_raw_artifacts_tenant_source_object
  ON raw_artifacts (tenant_id, source_id, object_type)
  WHERE source_id IS NOT NULL;

-- Envelope-level idempotency.
CREATE UNIQUE INDEX IF NOT EXISTS uq_raw_artifacts_tenant_idem
  ON raw_artifacts (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMIT;
