-- Accept x402 settlement PaymentIntents (v0.4 / RFC 0001 §7.1).
--
-- Two additive constraint relaxations so an x402 USDC-on-Base settlement can be
-- recorded as a PaymentIntent and flow through the SAME §6 gate + audit path as
-- every other payment (RFC 0001 §2 — never fork the payment path):
--
--   1. action_type gains 'x402_settle'.
--   2. currency gains 'USDC' (D-4: USDC on Base is the only on-chain asset). The
--      ISO-4217-style 3-letter check stays for fiat; USDC is the lone 4-letter
--      exception rather than a blanket relaxation, so fiat validation is unchanged.
--
-- Shadow-first: nothing settles until x402_settle is also in the route's
-- ACTION_TYPES AND the commerce agent is promoted to LIVE_AGENTS AND an
-- x402_base rail is registered at boot — all of which remain gated. This
-- migration only makes the row representable. Forward-compatible (no data
-- rewrite; existing rows already satisfy both widened predicates).

BEGIN;

ALTER TABLE ledger_payment_intents
  DROP CONSTRAINT IF EXISTS ledger_payment_intents_action_type_check;

ALTER TABLE ledger_payment_intents
  ADD CONSTRAINT ledger_payment_intents_action_type_check
  CHECK (action_type IN (
    'ach_outbound','ach_inbound','wire',
    'onchain_transfer','erp_writeback','card_payment','x402_settle','other'
  ));

ALTER TABLE ledger_payment_intents
  DROP CONSTRAINT IF EXISTS ledger_payment_intents_currency_check;

ALTER TABLE ledger_payment_intents
  ADD CONSTRAINT ledger_payment_intents_currency_check
  CHECK (currency ~ '^[A-Z]{3}$' OR currency = 'USDC');

COMMENT ON CONSTRAINT ledger_payment_intents_action_type_check ON ledger_payment_intents IS
  'Adds x402_settle for USDC-on-Base settlement (RFC 0001 §7.1); shadow-gated downstream.';

COMMIT;
