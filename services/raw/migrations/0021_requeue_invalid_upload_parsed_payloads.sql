-- Requeue upload extraction jobs whose current parsed row has an upload parser
-- id but a non-upload payload shape.
--
-- raw/0020 requeued terminal zero-row upload projections, but older migration
-- raw/0019 may already have removed the zero-row projection log. In that case
-- insertParsed saw an exact (raw_artifact_id, parser, parser_version) conflict
-- and returned the stale parsed row unchanged. This migration queues those
-- jobs again after the code-level payload-shape repair is available.
--
-- This mutates only extraction job state. The retained raw_artifacts bytes and
-- existing raw_parsed rows remain in place until the worker deterministically
-- reparses the bytes and repairs the derived parsed payload.

BEGIN;

WITH invalid_upload AS (
  SELECT ej.id AS job_id
    FROM extraction_jobs ej
    JOIN raw_parsed rp ON rp.id = ej.parsed_id
    JOIN raw_artifacts ra ON ra.id = rp.raw_artifact_id
   WHERE ej.status = 'succeeded'
     AND ej.parsed_id IS NOT NULL
     AND (
       (rp.parser = 'bank_statement_upload_v1'
        AND COALESCE(rp.extracted->>'object_type', '') <> 'bank_statement')
       OR
       (rp.parser = 'document_records_upload_v1'
        AND COALESCE(rp.extracted->>'object_type', '') NOT IN ('ar_aging', 'payroll_register'))
     )
     AND (
       ra.source_type IN ('pdf_upload', 'csv_upload')
       OR lower(split_part(COALESCE(ra.mime_type, ''), ';', 1)) IN (
         'application/pdf',
         'application/csv',
         'application/vnd.ms-excel',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'text/csv'
       )
     )
)
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
  FROM invalid_upload
 WHERE ej.id = invalid_upload.job_id;

COMMIT;
