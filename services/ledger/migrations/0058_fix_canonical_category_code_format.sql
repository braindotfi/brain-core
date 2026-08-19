-- Correct the canonical category code regex introduced by migration 0057.
-- Canonical taxonomy values use a literal dot, for example expense.cloud_infrastructure.

BEGIN;

ALTER TABLE ledger_categories
  DROP CONSTRAINT IF EXISTS ledger_categories_canonical_code_format;

ALTER TABLE ledger_categories
  ADD CONSTRAINT ledger_categories_canonical_code_format
  CHECK (
    canonical_code IS NULL
    OR canonical_code ~ '^(income|expense)\.[a-z0-9_]+$'
  );

ALTER TABLE ledger_transaction_category_assignments
  DROP CONSTRAINT IF EXISTS ledger_transaction_category_assignments_canonical_code_check;

ALTER TABLE ledger_transaction_category_assignments
  ADD CONSTRAINT ledger_transaction_category_assignments_canonical_code_format
  CHECK (canonical_code ~ '^(income|expense)\.[a-z0-9_]+$');

COMMIT;
