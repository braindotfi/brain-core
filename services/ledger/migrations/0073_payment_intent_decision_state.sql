-- Persist the latest explicit payment-intent proposal decision on the
-- authoritative Ledger row.

ALTER TABLE ledger_payment_intents
  ADD COLUMN IF NOT EXISTS decision TEXT,
  ADD COLUMN IF NOT EXISTS decision_audit_id TEXT,
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

ALTER TABLE ledger_payment_intents
  ADD CONSTRAINT ledger_payment_intents_decision_value_check
  CHECK (decision IS NULL OR decision IN ('approve', 'reject', 'acknowledge', 'undo')),
  ADD CONSTRAINT ledger_payment_intents_decision_receipt_complete_check
  CHECK (
    (decision IS NULL AND decision_audit_id IS NULL AND decided_at IS NULL)
    OR
    (decision IS NOT NULL AND decision_audit_id IS NOT NULL AND decided_at IS NOT NULL)
  );
