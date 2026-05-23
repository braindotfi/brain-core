-- Kill-switch (Agent Autonomy v3, 1b.3): add the `paused` status to payment
-- intents so an approved intent can be held (and resumed/cancelled) without a
-- terminal transition. Forward-compatible: widens the CHECK only.

BEGIN;

ALTER TABLE ledger_payment_intents
  DROP CONSTRAINT IF EXISTS ledger_payment_intents_status_check;

ALTER TABLE ledger_payment_intents
  ADD CONSTRAINT ledger_payment_intents_status_check
  CHECK (status IN (
    'proposed', 'pending_approval', 'approved', 'paused',
    'rejected', 'executed', 'failed', 'cancelled'
  ));

COMMIT;
