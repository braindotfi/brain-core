-- Clean up invoice reconciliation matches orphaned by duplicate invoice merges.
--
-- 0043 can delete a duplicate invoice after counterparty dedup collapses two
-- invoices with the same tenant, counterparty, and invoice number. The merge
-- map is no longer available after that migration commits, so orphaned invoice
-- matches are deleted and can be recreated by the reconciliation engine.

BEGIN;

DELETE FROM ledger_reconciliation_matches r
WHERE (
    r.left_entity_type = 'invoice'
    AND NOT EXISTS (
      SELECT 1
      FROM ledger_invoices i
      WHERE i.id = r.left_entity_id
    )
  )
  OR (
    r.right_entity_type = 'invoice'
    AND NOT EXISTS (
      SELECT 1
      FROM ledger_invoices i
      WHERE i.id = r.right_entity_id
    )
  );

COMMIT;
