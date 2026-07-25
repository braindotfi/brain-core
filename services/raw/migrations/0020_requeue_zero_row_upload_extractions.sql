-- Requeue succeeded upload extraction jobs whose parsed output only produced a
-- terminal zero-row canonical projection.
--
-- This is a derived-metadata repair for production rows that were parsed by the
-- generic external document extractor with an upload parser id but an
-- obligation-shaped payload. The raw_artifacts bytes, sha256, blob_uri, and
-- source_ref remain untouched, so Layer-1 immutability is preserved.
--
-- Keep the stale canonical_projection_log row in place here. The extraction
-- worker re-runs the deterministic in-process upload interpreter, and
-- raw_parsed.insertParsed detects that zero-row log, rewrites the derived
-- parsed payload, and deletes the log so canonical projection can replay it.

BEGIN;

WITH stale AS (
  SELECT ej.id AS job_id
    FROM extraction_jobs ej
    JOIN raw_parsed rp ON rp.id = ej.parsed_id
    JOIN raw_artifacts ra ON ra.id = rp.raw_artifact_id
    JOIN canonical_projection_log cpl ON cpl.raw_parsed_id = rp.id
   WHERE ej.status = 'succeeded'
     AND ej.parsed_id IS NOT NULL
     AND rp.parser IN ('bank_statement_upload_v1', 'document_records_upload_v1')
     AND cpl.records_written = 0
     AND cpl.error IS NULL
     AND COALESCE(cpl.quarantined, false) = false
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
  FROM stale
 WHERE ej.id = stale.job_id;

COMMIT;
