\pset pager off
\pset null '(null)'
BEGIN TRANSACTION READ ONLY;

\echo 'contextless_payroll_canonical_obligations'
SELECT tenant_id,
       id,
       source_natural_key,
       amount,
       currency,
       due_date,
       source_ids,
       evidence_ids
  FROM canonical_obligation
 WHERE source_system = 'document_upload'
   AND extensions#>>'{document_upload,object_type}' = 'payroll_register'
   AND source_natural_key ~ '^payroll:raw_[A-Z0-9]+:payroll:[0-9]+$'
   AND due_date IS NULL
 ORDER BY tenant_id, id;

\echo 'contextless_payroll_compact_obligations'
SELECT lo.owner_id AS tenant_id,
       lo.id,
       lo.amount_due,
       lo.currency,
       lo.due_date,
       lo.source_ids,
       lo.evidence_ids
  FROM ledger_obligations lo
  JOIN canonical_obligation co ON co.id = lo.canonical_obligation_id
 WHERE co.source_system = 'document_upload'
   AND co.extensions#>>'{document_upload,object_type}' = 'payroll_register'
   AND co.source_natural_key ~ '^payroll:raw_[A-Z0-9]+:payroll:[0-9]+$'
   AND co.due_date IS NULL
 ORDER BY lo.owner_id, lo.id;

COMMIT;
