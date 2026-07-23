-- Backfill upload artifacts that were ingested before document interpreters
-- stamped the default upload source schema.
--
-- This is a metadata correction only: it updates source_schema on upload rows
-- whose payload bytes already exist in raw_artifacts, and it does not rewrite
-- blob_uri, sha256, bytes, source_ref, or any retained raw bytes. Layer 1
-- immutability is preserved because the content-addressed payload stays
-- unchanged; this only makes the existing declared upload format visible to
-- the interpretation worker.

BEGIN;

UPDATE raw_artifacts
   SET source_schema = 'brain.upload.document.v1'
 WHERE source_type IN ('pdf_upload', 'csv_upload')
   AND source_schema IS NULL;

COMMIT;
