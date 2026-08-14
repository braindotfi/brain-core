-- RFC 0002 Phase C, increment 3: retry durability for the on-chain
-- registration relayer worker.
--
-- onchain_attestation_attempts / last_attestation_error / next_attempt_at
-- mirror the execution_outbox retry columns (services/execution/migrations
-- /0022_execution_outbox_retry_backoff.sql): a bounded exponential backoff
-- and an attempt ceiling so a permanently-reverting attestation cannot retry
-- forever, and next_attempt_at doubles as the worker's claim lease (see
-- repository.ts claimPendingOnchainAgentsForAttestation) so a crashed worker
-- self-heals without a separate locked_at/locked_by column.

BEGIN;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS onchain_attestation_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_attestation_error TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

COMMIT;
