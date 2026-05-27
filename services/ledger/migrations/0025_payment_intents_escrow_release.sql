-- Accept escrow-release PaymentIntents (v0.4 / RFC 0001 §7.6).
--
-- The conditional-settlement counterpart to x402_settle: a release of an
-- on-chain BrainEscrow lock flows through the SAME PaymentIntent → §6 gate →
-- audit path (RFC 0001 §2). Two additive changes:
--
--   1. action_type gains 'escrow_release' (currency 'USDC' is already accepted
--      by migration 0023's widened CHECK).
--   2. Carry the on-chain escrow context so the §6 escrow-state-binding check
--      (gate 6.6) can bind the intent to the lock: escrow_id + job_terms_hash.
--      A cross-column CHECK keeps both null for every other action type and a
--      0x bytes32 when present — hash-only (RFC 0001 §3), no PII on-chain.
--
-- Shadow-first: nothing releases until escrow_release is in the route's
-- ACTION_TYPES AND the commerce agent is in LIVE_AGENTS AND an escrow_base rail
-- is registered at boot (RailRegistry fails closed). Additive; no data rewrite.

BEGIN;

ALTER TABLE ledger_payment_intents
  DROP CONSTRAINT IF EXISTS ledger_payment_intents_action_type_check;

ALTER TABLE ledger_payment_intents
  ADD CONSTRAINT ledger_payment_intents_action_type_check
  CHECK (action_type IN (
    'ach_outbound','ach_inbound','wire',
    'onchain_transfer','erp_writeback','card_payment',
    'x402_settle','escrow_release','other'
  ));

ALTER TABLE ledger_payment_intents
  ADD COLUMN IF NOT EXISTS escrow_id TEXT;

ALTER TABLE ledger_payment_intents
  ADD COLUMN IF NOT EXISTS job_terms_hash TEXT;

ALTER TABLE ledger_payment_intents
  DROP CONSTRAINT IF EXISTS ledger_payment_intents_escrow_check;

-- escrow_id + job_terms_hash are set together, only for escrow_release, and each
-- is a 0x bytes32 (keccak commitment / escrow id) — no free-form text on-chain.
ALTER TABLE ledger_payment_intents
  ADD CONSTRAINT ledger_payment_intents_escrow_check
  CHECK (
    (escrow_id IS NULL AND job_terms_hash IS NULL)
    OR (
      action_type = 'escrow_release'
      AND escrow_id ~ '^0x[0-9a-fA-F]{64}$'
      AND job_terms_hash ~ '^0x[0-9a-fA-F]{64}$'
    )
  );

COMMENT ON COLUMN ledger_payment_intents.escrow_id IS
  'On-chain BrainEscrow id (bytes32) an escrow_release settles; null otherwise. RFC 0001 §7.6.';
COMMENT ON COLUMN ledger_payment_intents.job_terms_hash IS
  'keccak256 commitment of the escrow job terms (hash-only); null unless escrow_release. RFC 0001 §3/§7.6.';

COMMIT;
