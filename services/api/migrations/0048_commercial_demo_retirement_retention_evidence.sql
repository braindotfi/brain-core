ALTER TABLE commercial_demo_retirement_progress
  ADD COLUMN retention_subject_id TEXT,
  ADD COLUMN retention_receipt_id TEXT,
  ADD COLUMN retention_evidence_required BOOLEAN;

UPDATE commercial_demo_retirement_progress
   SET retention_evidence_required = (status <> 'completed');

ALTER TABLE commercial_demo_retirement_progress
  ALTER COLUMN retention_evidence_required SET DEFAULT true,
  ALTER COLUMN retention_evidence_required SET NOT NULL,
  ADD CONSTRAINT commercial_demo_retirement_retention_evidence_pair
    CHECK (
      (retention_subject_id IS NULL AND retention_receipt_id IS NULL)
      OR
      (
        retention_subject_id LIKE 'retsub_%'
        AND retention_receipt_id LIKE 'retreceipt_%'
      )
    ),
  ADD CONSTRAINT commercial_demo_retirement_completed_retention_evidence
    CHECK (
      status <> 'completed'
      OR NOT retention_evidence_required
      OR (retention_subject_id IS NOT NULL AND retention_receipt_id IS NOT NULL)
    );

COMMENT ON COLUMN commercial_demo_retirement_progress.retention_subject_id IS
  'Opaque HMAC-linked commercial evidence subject created in the tenant deletion transaction. Null only for attempts completed before retention evidence was implemented.';

COMMENT ON COLUMN commercial_demo_retirement_progress.retention_receipt_id IS
  'Stable retirement receipt identifier used to make retention preparation retry-safe. It is intentionally not a foreign key because protected expiry purges the source receipt while this operational progress record survives.';

COMMENT ON COLUMN commercial_demo_retirement_progress.retention_evidence_required IS
  'True for every retirement not already completed before retention integration. Prevents a new completed progress row without subject and receipt evidence.';
