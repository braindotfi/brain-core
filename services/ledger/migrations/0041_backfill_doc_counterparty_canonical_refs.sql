-- Backfill canonical counterparty refs onto pre-cutover Ledger counterparties,
-- the companion to ledger/0040 (which backfilled document OBLIGATIONS only).
--
-- ledger/0039 linked Merge counterparties by their remote contact id; the
-- document counterparty backfill was deferred because the obvious approach --
-- matching on normalized NAME -- risks mis-linking a document vendor to a
-- same-named Merge/Plaid counterparty. This avoids names entirely: a Ledger
-- counterparty that is the counterparty of an obligation ALREADY linked to a
-- canonical obligation (by 0039 for Merge, 0040 for documents) inherits that
-- canonical obligation's canonical_counterparty_id. The FK relationship, not
-- the name, carries the identity -> zero collision.
--
-- This also tidies any Merge counterparty 0039's contact-id match missed (e.g.
-- the invoice-embedded placeholder), since they too are reachable through their
-- obligation's FK. Forward-only and idempotent: only fills NULLs.
--
-- Must run AFTER 0039 + 0040 (which set ledger_obligations.canonical_obligation_id);
-- the global migration order (lexicographic within the ledger service) guarantees it.

BEGIN;

UPDATE ledger_counterparties lc
   SET canonical_counterparty_id = co.canonical_counterparty_id
  FROM ledger_obligations lo
  JOIN canonical_obligation co ON co.id = lo.canonical_obligation_id
 WHERE lo.owner_id = lc.owner_id
   AND lo.counterparty_id = lc.id
   AND co.canonical_counterparty_id IS NOT NULL
   AND lc.canonical_counterparty_id IS NULL;

COMMIT;
