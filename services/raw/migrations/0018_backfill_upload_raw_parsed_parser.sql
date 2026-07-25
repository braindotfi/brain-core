-- Backfill parser on extraction-agent-written upload raw_parsed rows that
-- predate parser propagation from the document extraction agent.
--
-- This is a metadata correction only: it updates the parser identifier on
-- derived raw_parsed rows so the canonical projector can poll them. It does not
-- rewrite raw_artifacts payload bytes, blob_uri, sha256, source_ref, or any
-- retained document content. Rows that already have a parser are left as-is.

BEGIN;

UPDATE raw_parsed rp
   SET parser = CASE ra.source_type
                  WHEN 'pdf_upload' THEN 'bank_statement_upload_v1'
                  WHEN 'csv_upload' THEN 'document_records_upload_v1'
                END
  FROM raw_artifacts ra
 WHERE rp.raw_artifact_id = ra.id
   AND rp.parser IS NULL
   AND ra.source_type IN ('pdf_upload', 'csv_upload');

COMMIT;
