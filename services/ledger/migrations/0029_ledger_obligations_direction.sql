-- Brain Ledger -- obligation direction (payable vs receivable).
--
-- The doc_obligation_v1 parser already carries a `direction` field
-- ("payable" = vendor we owe; "receivable" = customer who owes us), but the
-- column never landed in the obligations table, so the extractor was dropping
-- it on the floor. That left the §6 gate unable to distinguish an outflow
-- targeting an obligation we owe ("pay this vendor") from an outflow targeting
-- an obligation owed TO us ("...send money to the customer who owes us?").
--
-- Batch 10 H-1 adds the column, backfills existing rows from the counterparty
-- type, and lets the §6 gate reject outflow payment-intents whose linked
-- obligation is a receivable.
--
-- Additive + nullable-by-default with backfill, so the migration is forward-
-- compatible: existing rows get a sensible direction, and the gate falls back
-- to "no direction known = no extra check" for rows the backfill cannot infer.

BEGIN;

ALTER TABLE ledger_obligations
  ADD COLUMN IF NOT EXISTS direction TEXT
    CHECK (direction IS NULL OR direction IN ('payable', 'receivable'));

-- Backfill from the counterparty type. Vendors are the AP side (we pay them ->
-- payable). Customers are the AR side (they pay us -> receivable). Other
-- counterparty types (bank, partner, internal) stay NULL, so the gate's
-- direction check treats them as "direction unknown" rather than guessing.
UPDATE ledger_obligations o
   SET direction = CASE c.type
                     WHEN 'vendor'   THEN 'payable'
                     WHEN 'customer' THEN 'receivable'
                     ELSE NULL
                   END
  FROM ledger_counterparties c
 WHERE o.counterparty_id = c.id
   AND o.direction IS NULL;

CREATE INDEX IF NOT EXISTS idx_ledger_obligations_owner_direction
  ON ledger_obligations (owner_id, direction)
  WHERE direction IS NOT NULL;

COMMIT;
