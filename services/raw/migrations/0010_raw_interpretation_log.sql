-- Brain Raw -- interpretation log (Appendix B mechanism 2).
--
-- One row per artifact the interpretation worker has processed, mirroring
-- the Ledger's normalization_log: the worker polls raw_artifacts whose
-- declared source_schema has a registered interpreter AND no row here, so
-- repeated cycles are idempotent and an artifact whose interpreter yields no
-- parsed row (empty delta page) is not re-polled forever. Replays (new
-- interpreter version over history) bypass this log deliberately: they are
-- operator-driven, not worker-driven.

BEGIN;

CREATE TABLE IF NOT EXISTS raw_interpretation_log (
  raw_artifact_id  TEXT        PRIMARY KEY,
  tenant_id        TEXT        NOT NULL,
  source_schema    TEXT        NOT NULL,
  parsed_id        TEXT,                  -- NULL when the interpreter yielded no row
  error            TEXT,                  -- NULL on success
  interpreted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raw_interpretation_log_tenant_schema
  ON raw_interpretation_log (tenant_id, source_schema, interpreted_at DESC);

ALTER TABLE raw_interpretation_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON raw_interpretation_log
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_write ON raw_interpretation_log
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE raw_interpretation_log FORCE ROW LEVEL SECURITY;

COMMIT;
