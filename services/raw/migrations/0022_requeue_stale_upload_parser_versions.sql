-- Requeue upload extraction jobs whose current parser output was produced by
-- an older upload interpreter version.
--
-- Older bank-statement and payroll upload parses can have a valid object_type
-- while still carrying stale content, such as 15 bank transactions instead of
-- the corrected 19, or per-employee payroll obligations instead of run-level
-- obligations. Shape-only recovery migrations do not catch those rows.
--
-- This is a deterministic metadata recovery. It does not mutate retained
-- raw_artifacts bytes or delete historical raw_parsed evidence. It only asks
-- the extraction worker to re-run the current registered interpreter against
-- the immutable bytes. The new parser_version makes the corrected parse a new
-- raw_parsed row, and canonical projection will process it normally.

BEGIN;

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
  JOIN raw_artifacts ra ON ra.id = rp.raw_artifact_id
 WHERE ej.parsed_id = rp.id
   AND ej.status = 'succeeded'
   AND rp.parser IN ('bank_statement_upload_v1', 'document_records_upload_v1')
   AND rp.parser_version <> '1.0.1'
   AND (
     ra.source_type IN ('pdf_upload', 'csv_upload')
     OR lower(split_part(COALESCE(ra.mime_type, ''), ';', 1)) IN (
       'application/pdf',
       'application/csv',
       'application/vnd.ms-excel',
       'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
       'text/csv'
     )
   );

COMMIT;
