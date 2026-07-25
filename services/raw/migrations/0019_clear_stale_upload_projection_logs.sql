-- Clear stale canonical projection logs for upload parsed rows whose parser
-- metadata was corrected by raw/0018.
--
-- raw_parsed.parser is derived metadata over retained raw_artifacts bytes. When
-- parser was NULL or wrong, canonical projection could record a terminal
-- zero-row pass. Once parser metadata is corrected, that log row is stale:
-- the projector's pending exclusion treats it as already projected and will not
-- replay the corrected parsed output. Deleting only those terminal zero-row log
-- entries is a replay marker correction. It does not mutate raw_artifacts
-- payload bytes, blob_uri, sha256, source_ref, or retained document content, so
-- Layer-1 immutability remains intact. Successful projection logs are preserved.

BEGIN;

DELETE FROM canonical_projection_log cpl
 USING raw_parsed rp
 JOIN raw_artifacts ra ON ra.id = rp.raw_artifact_id
 WHERE cpl.raw_parsed_id = rp.id
   AND cpl.records_written = 0
   AND cpl.error IS NULL
   AND COALESCE(cpl.quarantined, false) = false
   AND ra.source_type IN ('pdf_upload', 'csv_upload')
   AND rp.parser = CASE ra.source_type
                     WHEN 'pdf_upload' THEN 'bank_statement_upload_v1'
                     WHEN 'csv_upload' THEN 'document_records_upload_v1'
                   END;

COMMIT;
