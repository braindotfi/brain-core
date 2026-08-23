-- Support the stable transaction subject lookup used to refresh one pending
-- reconciliation proposal in place. Historical duplicates remain untouched.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_proposals_reconciliation_pending_txn
  ON proposals (tenant_id, (action->>'transaction_id'), created_at DESC, id DESC)
  WHERE proposing_agent = 'reconciliation'
    AND status = 'pending'
    AND action->>'transaction_id' IS NOT NULL
    AND action->>'transaction_id' <> '';

COMMIT;
