-- Outbox retry backoff clock.
--
-- `reconciling` rows are deliberately claimable (the spec wants stuck rows
-- retried), but the claim query had no notion of "tried recently" or "tried
-- too often": a deterministic on-chain revert (ExceedsPerTxCap) cycled one row
-- dispatching → reconciling on every 1s poll, reaching attempt_count 304+ in
-- ~10 minutes against the Base Sepolia RPC.
--
-- last_attempt_at is stamped by every attempt-recording write (markFailed /
-- markReconciling / markPermanentlyFailed); claimNext only picks a row whose
-- exponential backoff window (30s * 2^(attempt_count-1), capped at 480s — the
-- same schedule as the webhook DLQ in shared/src/webhooks/dead-letters.ts) has
-- elapsed AND whose attempt_count is under the hard ceiling
-- (MAX_TOTAL_DISPATCH_ATTEMPTS in OutboxService.ts). Existing rows keep
-- last_attempt_at NULL = immediately claimable, same as today.

BEGIN;

ALTER TABLE execution_outbox
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

COMMIT;
