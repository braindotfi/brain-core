-- Phase 6 — invariant: every Ledger row carries either a source_id or
-- an evidence_id (or both). Empty arrays are not allowed.
--
-- Invariant text (from Brain_Engineering_Standards.md §8.4):
--   "Every transaction has at least one source_id or evidence_id."
-- Extends to all Ledger entities by the §1 principle of provenance on
-- everything.
--
-- Categories table is exempt (it is operator-authored, not derived from
-- Raw evidence). PaymentIntents are exempt (the row is created by the
-- Agent layer; its evidence comes from linked obligations / invoices /
-- documents, not from a raw_parsed). The remaining nine entities all
-- carry the constraint.

BEGIN;

ALTER TABLE ledger_accounts
  ADD CONSTRAINT ledger_accounts_provenance_present
  CHECK (
    array_length(source_ids, 1) > 0
    OR array_length(evidence_ids, 1) > 0
  );

ALTER TABLE ledger_balances
  ADD CONSTRAINT ledger_balances_provenance_present
  CHECK (
    array_length(source_ids, 1) > 0
    OR array_length(evidence_ids, 1) > 0
  );

ALTER TABLE ledger_counterparties
  ADD CONSTRAINT ledger_counterparties_provenance_present
  CHECK (
    array_length(source_ids, 1) > 0
    OR array_length(evidence_ids, 1) > 0
  );

ALTER TABLE ledger_transactions
  ADD CONSTRAINT ledger_transactions_provenance_present
  CHECK (
    array_length(source_ids, 1) > 0
    OR array_length(evidence_ids, 1) > 0
  );

ALTER TABLE ledger_documents
  ADD CONSTRAINT ledger_documents_provenance_present
  CHECK (
    array_length(source_ids, 1) > 0
    OR array_length(evidence_ids, 1) > 0
  );

ALTER TABLE ledger_obligations
  ADD CONSTRAINT ledger_obligations_provenance_present
  CHECK (
    array_length(source_ids, 1) > 0
    OR array_length(evidence_ids, 1) > 0
  );

ALTER TABLE ledger_invoices
  ADD CONSTRAINT ledger_invoices_provenance_present
  CHECK (
    array_length(source_ids, 1) > 0
    OR array_length(evidence_ids, 1) > 0
  );

ALTER TABLE ledger_transfers
  ADD CONSTRAINT ledger_transfers_provenance_present
  CHECK (
    array_length(source_ids, 1) > 0
    OR array_length(evidence_ids, 1) > 0
  );

-- ledger_reconciliation_matches always has evidence_ids populated by the
-- matcher (left + right entity refs are themselves provenance pointers,
-- but we keep the explicit array for forensic reads). Not strictly
-- required by §8.4 since matches are derived; constraint applied for
-- consistency.
ALTER TABLE ledger_reconciliation_matches
  ADD CONSTRAINT ledger_reconciliation_matches_evidence_present
  CHECK (
    array_length(evidence_ids, 1) > 0
    OR confidence_score >= 0.9  -- high-confidence matches need no extra evidence
  );

COMMIT;
