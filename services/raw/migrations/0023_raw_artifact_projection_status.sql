-- Per-document projection lifecycle status.
--
-- This is a processing lifecycle signal, not a semantic row-count validator:
-- `projected` means the upload projection side-effect chain completed for this
-- raw artifact. Consumers should still use audit outputs such as
-- ledger.apar_projection.rebuilt for produced-row diagnostics.

BEGIN;

ALTER TABLE raw_artifacts
  ADD COLUMN IF NOT EXISTS projection_status TEXT
    CHECK (projection_status IN (
      'pending',
      'projecting',
      'projected',
      'projection_timed_out',
      'projection_failed'
    )),
  ADD COLUMN IF NOT EXISTS projection_status_updated_at TIMESTAMPTZ;

UPDATE raw_artifacts
   SET projection_status = 'pending',
       projection_status_updated_at = COALESCE(projection_status_updated_at, now())
 WHERE projection_status IS NULL
   AND source_schema = 'brain.upload.document.v1';

COMMIT;
