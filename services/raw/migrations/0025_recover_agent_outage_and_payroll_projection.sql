-- Recover document jobs that exhausted bounded retries while the external
-- extraction agent credential was unavailable, and replay stale payroll
-- projection output after the run-level upload interpreter replacement.
--
-- This is metadata and derived-projection repair only. Retained raw bytes and
-- historical raw_parsed evidence are never changed or deleted. The retry
-- policy remains bounded; this one-time recovery is intentionally restricted
-- to the documented agent-unreachable terminal error.

BEGIN;

WITH recovered AS (
  UPDATE extraction_jobs
     SET status = 'queued',
         parsed_id = NULL,
         confidence = NULL,
         error = NULL,
         attempt_count = 0,
         next_attempt_at = NULL,
         locked_at = NULL,
         locked_by = NULL,
         started_at = NULL,
         finished_at = NULL,
         updated_at = now()
   WHERE status = 'failed'
     AND error->>'code' = 'internal_server_error'
     AND error->>'message' = 'document extraction agent unreachable'
 RETURNING raw_id
)
UPDATE raw_artifacts ra
   SET projection_status = 'pending',
       projection_status_updated_at = now()
  FROM recovered r
 WHERE ra.id = r.raw_id;

-- Version 1.0.1 emitted one payroll obligation per employee. Version 1.0.2
-- emits one row per pay run. Remove only stale, rebuildable canonical and
-- compact payroll rows when both versions exist for the same retained artifact,
-- then replay the current parser row. Keeping the 1.0.1 projection log prevents
-- the obsolete per-employee output from being selected again.
WITH affected AS (
  SELECT DISTINCT old.tenant_id, old.raw_artifact_id
    FROM raw_parsed old
    JOIN raw_parsed current
      ON current.tenant_id = old.tenant_id
     AND current.raw_artifact_id = old.raw_artifact_id
   WHERE old.parser = 'document_records_upload_v1'
     AND old.parser_version = '1.0.1'
     AND old.extracted->>'object_type' = 'payroll_register'
     AND current.parser = 'document_records_upload_v1'
     AND current.parser_version = '1.0.2'
     AND current.extracted->>'object_type' = 'payroll_register'
)
DELETE FROM ledger_obligations lo
USING canonical_obligation co, affected a
WHERE lo.canonical_obligation_id = co.id
  AND co.tenant_id = a.tenant_id
  AND co.source_system = 'document_upload'
  AND co.extensions#>>'{document_upload,object_type}' = 'payroll_register'
  AND co.source_ids @> ARRAY[a.raw_artifact_id]::text[];

WITH affected AS (
  SELECT DISTINCT old.tenant_id, old.raw_artifact_id
    FROM raw_parsed old
    JOIN raw_parsed current
      ON current.tenant_id = old.tenant_id
     AND current.raw_artifact_id = old.raw_artifact_id
   WHERE old.parser = 'document_records_upload_v1'
     AND old.parser_version = '1.0.1'
     AND old.extracted->>'object_type' = 'payroll_register'
     AND current.parser = 'document_records_upload_v1'
     AND current.parser_version = '1.0.2'
     AND current.extracted->>'object_type' = 'payroll_register'
)
DELETE FROM ledger_counterparties lc
USING canonical_counterparty cc, affected a
WHERE lc.canonical_counterparty_id = cc.id
  AND cc.tenant_id = a.tenant_id
  AND cc.source_system = 'document_upload'
  AND cc.extensions#>>'{document_upload,object_type}' = 'payroll_register'
  AND cc.source_ids @> ARRAY[a.raw_artifact_id]::text[];

WITH affected AS (
  SELECT DISTINCT old.tenant_id, old.raw_artifact_id
    FROM raw_parsed old
    JOIN raw_parsed current
      ON current.tenant_id = old.tenant_id
     AND current.raw_artifact_id = old.raw_artifact_id
   WHERE old.parser = 'document_records_upload_v1'
     AND old.parser_version = '1.0.1'
     AND old.extracted->>'object_type' = 'payroll_register'
     AND current.parser = 'document_records_upload_v1'
     AND current.parser_version = '1.0.2'
     AND current.extracted->>'object_type' = 'payroll_register'
)
DELETE FROM canonical_obligation co
USING affected a
WHERE co.tenant_id = a.tenant_id
  AND co.source_system = 'document_upload'
  AND co.extensions#>>'{document_upload,object_type}' = 'payroll_register'
  AND co.source_ids @> ARRAY[a.raw_artifact_id]::text[];

WITH affected AS (
  SELECT DISTINCT old.tenant_id, old.raw_artifact_id
    FROM raw_parsed old
    JOIN raw_parsed current
      ON current.tenant_id = old.tenant_id
     AND current.raw_artifact_id = old.raw_artifact_id
   WHERE old.parser = 'document_records_upload_v1'
     AND old.parser_version = '1.0.1'
     AND old.extracted->>'object_type' = 'payroll_register'
     AND current.parser = 'document_records_upload_v1'
     AND current.parser_version = '1.0.2'
     AND current.extracted->>'object_type' = 'payroll_register'
)
DELETE FROM canonical_counterparty cc
USING affected a
WHERE cc.tenant_id = a.tenant_id
  AND cc.source_system = 'document_upload'
  AND cc.extensions#>>'{document_upload,object_type}' = 'payroll_register'
  AND cc.source_ids @> ARRAY[a.raw_artifact_id]::text[];

WITH affected AS (
  SELECT DISTINCT old.tenant_id, old.raw_artifact_id
    FROM raw_parsed old
    JOIN raw_parsed current
      ON current.tenant_id = old.tenant_id
     AND current.raw_artifact_id = old.raw_artifact_id
   WHERE old.parser = 'document_records_upload_v1'
     AND old.parser_version = '1.0.1'
     AND old.extracted->>'object_type' = 'payroll_register'
     AND current.parser = 'document_records_upload_v1'
     AND current.parser_version = '1.0.2'
     AND current.extracted->>'object_type' = 'payroll_register'
)
DELETE FROM canonical_projection_log cpl
USING raw_parsed current, affected a
WHERE cpl.raw_parsed_id = current.id
  AND current.tenant_id = a.tenant_id
  AND current.raw_artifact_id = a.raw_artifact_id
  AND current.parser = 'document_records_upload_v1'
  AND current.parser_version = '1.0.2'
  AND current.extracted->>'object_type' = 'payroll_register';

WITH affected AS (
  SELECT DISTINCT old.raw_artifact_id
    FROM raw_parsed old
    JOIN raw_parsed current
      ON current.tenant_id = old.tenant_id
     AND current.raw_artifact_id = old.raw_artifact_id
   WHERE old.parser = 'document_records_upload_v1'
     AND old.parser_version = '1.0.1'
     AND old.extracted->>'object_type' = 'payroll_register'
     AND current.parser = 'document_records_upload_v1'
     AND current.parser_version = '1.0.2'
     AND current.extracted->>'object_type' = 'payroll_register'
)
UPDATE raw_artifacts ra
   SET projection_status = 'pending',
       projection_status_updated_at = now()
  FROM affected a
 WHERE ra.id = a.raw_artifact_id;

COMMIT;
