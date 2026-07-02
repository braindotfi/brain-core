-- Members approval authority: add the intermediate second-approval status.
--
-- A high-value or two-signer PaymentIntent can have one valid member approval
-- recorded while execution remains gated. The row stays non-executable until a
-- distinct member completes approval and the service transitions it to approved.

BEGIN;

ALTER TABLE ledger_payment_intents
  DROP CONSTRAINT IF EXISTS ledger_payment_intents_status_check;

ALTER TABLE ledger_payment_intents
  ADD CONSTRAINT ledger_payment_intents_status_check
  CHECK (status IN (
    'proposed', 'pending_approval', 'awaiting_second_approval', 'approved',
    'paused', 'dispatching', 'rejected', 'executed', 'failed', 'cancelled'
  ));

COMMIT;
