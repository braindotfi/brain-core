-- H-04 durable execution outbox: add the `dispatching` status to payment
-- intents. `execute` no longer drives approved → executed synchronously; it
-- atomically enqueues an execution_outbox row (services/execution) and moves the
-- intent approved → dispatching. The outbox worker then dispatches the rail and
-- settles dispatching → executed (or → failed). The intermediate state is what
-- makes a crash between rail dispatch and the final write recoverable.
--
-- The PaymentIntent row lives in the Ledger schema (`ledger_payment_intents`),
-- so the CHECK constraint that admits the new status is widened here, not in
-- services/execution. Forward-compatible: widens the CHECK only (mirrors the
-- 0016 `paused` migration). The original constraint is replaced, not modified.

BEGIN;

ALTER TABLE ledger_payment_intents
  DROP CONSTRAINT IF EXISTS ledger_payment_intents_status_check;

ALTER TABLE ledger_payment_intents
  ADD CONSTRAINT ledger_payment_intents_status_check
  CHECK (status IN (
    'proposed', 'pending_approval', 'approved', 'paused', 'dispatching',
    'rejected', 'executed', 'failed', 'cancelled'
  ));

COMMIT;
