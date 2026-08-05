-- Positive AR classification for Ledger API consumers.
--
-- Receivable canonical obligations are accounts receivable. Preserve all
-- existing metadata while adding the stable scenario marker to both the
-- obligation and its invoice mirror. Demo-seeded AR invoices predate the
-- canonical mirror, so recognize their explicitly AR-tagged counterparties.

BEGIN;

UPDATE ledger_obligations
   SET metadata = metadata || jsonb_build_object('scenario', 'ar'),
       updated_at = now()
 WHERE direction = 'receivable'
   AND metadata->>'scenario' IS DISTINCT FROM 'ar';

UPDATE ledger_invoices li
   SET metadata = li.metadata || jsonb_build_object('scenario', 'ar'),
       updated_at = now()
  FROM ledger_obligations lo
 WHERE lo.owner_id = li.owner_id
   AND lo.canonical_obligation_id = li.canonical_obligation_id
   AND lo.direction = 'receivable'
   AND li.metadata->>'scenario' IS DISTINCT FROM 'ar';

UPDATE ledger_invoices li
   SET metadata = li.metadata || jsonb_build_object('scenario', 'ar'),
       updated_at = now()
  FROM ledger_counterparties cp
 WHERE cp.owner_id = li.owner_id
   AND cp.id = li.counterparty_id
   AND cp.metadata->>'scenario' = 'ar'
   AND li.metadata->>'scenario' IS DISTINCT FROM 'ar';

COMMIT;
