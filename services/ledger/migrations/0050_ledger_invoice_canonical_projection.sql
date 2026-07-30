-- Ledger invoices as a rebuildable projection of canonical receivable obligations.
--
-- ledger_obligations already carries canonical_obligation_id. Receivable invoice
-- obligations also need to populate ledger_invoices, which is what collections,
-- cash forecast, and invoice read endpoints use. This soft reference makes the
-- invoice mirror idempotent without changing the canonical payload or retained
-- evidence bytes.

BEGIN;

ALTER TABLE ledger_invoices
  ADD COLUMN IF NOT EXISTS canonical_obligation_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_invoices_canonical_obligation
  ON ledger_invoices (owner_id, canonical_obligation_id)
  WHERE canonical_obligation_id IS NOT NULL;

COMMIT;
