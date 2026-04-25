-- Wiki kind narrowing — v0.3 hard cutover.
--
-- v0.1 of the Wiki layer used wiki_entities to store typed financial truth
-- (transaction, account, counterparty, obligation) alongside cross-layer
-- pointer types (policy, agent). v0.3 moves financial truth to the new
-- Ledger layer (services/ledger). Wiki keeps only the pointer types so
-- that /wiki/entity/{id} can still serve `policy` and `agent` lookups
-- the legacy clients depend on.
--
-- Hard cutover policy (per refactor-3 plan): no compatibility window.
-- Any rows with kind in (transaction, account, counterparty, obligation)
-- must have been migrated to ledger_* tables before this migration runs.
-- The new CHECK is applied unconditionally; the runner reports an error
-- if pre-existing rows would be violated, and the operator must reconcile
-- by hand (none expected at MVP because the system is pre-launch).

BEGIN;

-- 1. Drop the old CHECK constraint by dropping and re-creating the column
--    constraint. PG names the implicit constraint after the column; we
--    discover and drop it.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT conname INTO con_name
    FROM pg_constraint
   WHERE conrelid = 'wiki_entities'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%kind%account%counterparty%transaction%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE wiki_entities DROP CONSTRAINT %I', con_name);
  END IF;
END$$;

-- 2. Apply the v0.3 CHECK. Only `policy` and `agent` are retained; both
--    are pointer types whose canonical record lives in another service.
ALTER TABLE wiki_entities
  ADD CONSTRAINT wiki_entities_kind_v0_3_check
  CHECK (kind IN ('policy', 'agent'));

-- 3. Sanity guard. If any existing row violates the new CHECK, the ADD
--    above would fail. We add a NOT VALID/VALIDATE pattern in production
--    to allow back-pressure cleanup; for MVP the system is pre-launch and
--    has no rows to migrate, so the strict ADD is correct.

COMMIT;
