-- Requeue two recoverable upload states after the current interpreter and
-- external document-extractor runtime are repaired.
--
-- Raw bytes and historical parsed evidence remain immutable. This changes only
-- extraction-job scheduling so the worker can derive a new parser-versioned
-- row from the retained artifact after deployment.

BEGIN;

-- Payroll registers parsed by 1.0.1 may contain one obligation per employee
-- when the export omits an explicit run id. Version 1.0.2 aggregates those
-- rows by pay date, which is the compact-ledger projection's run boundary.
UPDATE extraction_jobs ej
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
  FROM raw_parsed rp
 WHERE ej.parsed_id = rp.id
   AND ej.status = 'succeeded'
   AND rp.parser = 'document_records_upload_v1'
   AND rp.parser_version = '1.0.1'
   AND rp.extracted->>'object_type' = 'payroll_register';

-- The agent process was unavailable while its write-back JWT was expired.
-- These artifacts have no parser output and are safe to retry once the
-- agent-health deploy gate and replacement credential are in place.
UPDATE extraction_jobs
   SET status = 'queued',
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
   AND error->>'message' = 'document extraction agent unreachable';

COMMIT;
