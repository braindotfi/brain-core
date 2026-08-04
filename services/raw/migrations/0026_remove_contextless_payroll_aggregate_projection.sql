-- Remove derived payroll obligations created by the v1.0.2 context-less
-- summary-row fallback. A valid payroll run always has a pay date; the bad
-- rows use the synthetic raw:<id>:payroll:<ordinal> key and NULL due_date.
-- Retained raw bytes and raw_parsed evidence are intentionally untouched.

BEGIN;

DELETE FROM ledger_obligations lo
USING canonical_obligation co
WHERE lo.canonical_obligation_id = co.id
  AND co.source_system = 'document_upload'
  AND co.extensions#>>'{document_upload,object_type}' = 'payroll_register'
  AND co.source_natural_key ~ '^payroll:raw_[A-Z0-9]+:payroll:[0-9]+$'
  AND co.due_date IS NULL;

DELETE FROM canonical_obligation co
WHERE co.source_system = 'document_upload'
  AND co.extensions#>>'{document_upload,object_type}' = 'payroll_register'
  AND co.source_natural_key ~ '^payroll:raw_[A-Z0-9]+:payroll:[0-9]+$'
  AND co.due_date IS NULL;

COMMIT;
