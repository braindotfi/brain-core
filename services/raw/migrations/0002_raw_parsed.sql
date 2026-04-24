-- Brain raw_parsed table.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 1.
-- Owner: services/raw. Populated by stage-3 extractors; stage-2 only creates
-- the schema so the /raw/{raw_id}/parsed endpoint returns an empty list
-- rather than 501.

BEGIN;

CREATE TABLE IF NOT EXISTS raw_parsed (
  id                TEXT        PRIMARY KEY,                  -- Brain ULID: prs_...
  raw_artifact_id   TEXT        NOT NULL REFERENCES raw_artifacts(id) ON DELETE RESTRICT,
  tenant_id         TEXT        NOT NULL,                     -- denormalized for RLS
  parser            TEXT        NOT NULL,                     -- e.g. plaid_tx_v1
  parser_version    TEXT        NOT NULL,
  extracted         JSONB       NOT NULL,
  confidence        REAL        CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  extracted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (raw_artifact_id, parser, parser_version)           -- one row per (artifact, parser version)
);

CREATE INDEX IF NOT EXISTS idx_raw_parsed_tenant_artifact
  ON raw_parsed (tenant_id, raw_artifact_id);

CREATE INDEX IF NOT EXISTS idx_raw_parsed_tenant_parser
  ON raw_parsed (tenant_id, parser);

ALTER TABLE raw_parsed ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON raw_parsed
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_write ON raw_parsed
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
