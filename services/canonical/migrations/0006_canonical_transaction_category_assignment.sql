-- Optional explicit category metadata from source records. Ledger owns the
-- tenant-local category and assignment-history projection.

BEGIN;

ALTER TABLE canonical_transaction
  ADD COLUMN IF NOT EXISTS canonical_category_code TEXT,
  ADD COLUMN IF NOT EXISTS category_assignment_method TEXT,
  ADD COLUMN IF NOT EXISTS category_assignment_confidence REAL,
  ADD COLUMN IF NOT EXISTS category_rule_version TEXT,
  ADD COLUMN IF NOT EXISTS category_source_value TEXT;

ALTER TABLE canonical_transaction
  ADD CONSTRAINT canonical_transaction_category_assignment_valid
  CHECK (
    (canonical_category_code IS NULL
      AND category_assignment_method IS NULL
      AND category_assignment_confidence IS NULL
      AND category_rule_version IS NULL
      AND category_source_value IS NULL)
    OR (
      canonical_category_code ~ '^(income|expense)\\.[a-z0-9_]+$'
      AND category_assignment_method IN ('source_provided', 'deterministic_rule')
      AND category_assignment_confidence BETWEEN 0.0 AND 1.0
    )
  );

COMMIT;
