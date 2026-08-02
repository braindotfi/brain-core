-- Brain Ledger -- first-class counterparty trust state.
--
-- This is intentionally separate from verified_status. verified_status remains
-- the source-verification field; trust_status is the user-reviewed workflow
-- state for counterparty review queues. ledger_counterparties already has
-- ENABLE and FORCE ROW LEVEL SECURITY plus tenant policies in earlier
-- migrations, so adding tenant-scoped columns does not require a new policy.

BEGIN;

ALTER TABLE ledger_counterparties
  ADD COLUMN IF NOT EXISTS trust_status TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (trust_status IN ('unreviewed','trusted','paused','acknowledged')),
  ADD COLUMN IF NOT EXISTS trust_reviewed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS trust_reviewed_by TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_ledger_counterparties_owner_trust_status
  ON ledger_counterparties (owner_id, trust_status);

COMMIT;
