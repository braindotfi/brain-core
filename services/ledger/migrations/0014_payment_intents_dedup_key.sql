-- Proposal-layer idempotency on payment intents (Agent Autonomy v3, 1a.5).
-- A money-mover that proposes the same payment twice within a run collides on
-- this key instead of creating two intents. Forward-compatible: additive column
-- + partial unique index. owner_id is the tenant column on this table.

BEGIN;

ALTER TABLE ledger_payment_intents ADD COLUMN IF NOT EXISTS proposal_dedup_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_payment_intents_owner_dedup
  ON ledger_payment_intents (owner_id, proposal_dedup_key)
  WHERE proposal_dedup_key IS NOT NULL;

COMMIT;
