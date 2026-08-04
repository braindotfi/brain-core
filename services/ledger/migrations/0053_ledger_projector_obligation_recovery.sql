-- Repair the runtime grant footprint for the canonical AP/AR projector and
-- assign canonical projection rows an explicit idempotency key.
--
-- The desired role definition in infra/db-roles.sql already includes these
-- projection targets. Existing environments that applied 0051 without a
-- subsequent db-role reconciliation missed ledger_obligations and
-- ledger_counterparties, leaving payroll compact projection unable to write.
-- Canonical rows use their immutable canonical id as an external key so they
-- cannot collide with the legacy direct-write dedup index.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'brain_ledger_projector') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON ledger_counterparties, ledger_obligations TO brain_ledger_projector';
  END IF;
END
$$;

UPDATE ledger_obligations
   SET external_key = 'canonical:' || canonical_obligation_id,
       updated_at = now()
 WHERE canonical_obligation_id IS NOT NULL
   AND external_key IS NULL;

-- Demo AP invoices were seeded before their payable obligation projection was
-- added. Backfill only the explicitly tagged demo AP rows; customer AR invoices
-- and externally ingested invoices are intentionally outside this correction.
INSERT INTO ledger_obligations (
  id, owner_id, type, counterparty_id, amount_due, minimum_due, currency,
  due_date, recurrence, status, linked_transaction_ids, source_ids, evidence_ids,
  provenance, confidence, direction, metadata, external_key
)
SELECT
  'obl_' || replace(gen_random_uuid()::text, '-', ''),
  li.owner_id,
  'bill',
  li.counterparty_id,
  li.amount_due,
  NULL,
  li.currency,
  li.due_date,
  NULL,
  CASE
    WHEN li.status = 'paid' THEN 'paid'
    WHEN li.status = 'cancelled' THEN 'cancelled'
    WHEN li.status = 'disputed' THEN 'disputed'
    WHEN li.status = 'overdue' THEN 'overdue'
    ELSE 'upcoming'
  END,
  ARRAY[]::text[],
  li.source_ids,
  li.evidence_ids,
  li.provenance,
  li.confidence,
  'payable',
  COALESCE(li.metadata, '{}'::jsonb) || jsonb_build_object('invoice_id', li.id),
  'demo:ap:' || li.invoice_number
FROM ledger_invoices li
WHERE li.metadata->>'scenario' = 'ap'
ON CONFLICT (owner_id, external_key) WHERE external_key IS NOT NULL DO NOTHING;

COMMIT;
