-- Persist the latest explicit proposal decision on the authoritative proposal
-- row so clients never need to reconstruct current state from audit history.

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS decision TEXT,
  ADD COLUMN IF NOT EXISTS decision_audit_id TEXT,
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

ALTER TABLE proposals
  ADD CONSTRAINT proposals_decision_value_check
  CHECK (decision IS NULL OR decision IN ('approve', 'reject', 'acknowledge', 'undo')),
  ADD CONSTRAINT proposals_decision_receipt_complete_check
  CHECK (
    (decision IS NULL AND decision_audit_id IS NULL AND decided_at IS NULL)
    OR
    (decision IS NOT NULL AND decision_audit_id IS NOT NULL AND decided_at IS NOT NULL)
  );
