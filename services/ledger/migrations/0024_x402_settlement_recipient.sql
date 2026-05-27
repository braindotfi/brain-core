-- Carry the x402 on-chain settlement recipient end-to-end (v0.4 / RFC 0001 §6.1).
--
-- Two additive columns so the §6 gate's x402 payment-context check (6.5) can
-- confirm the settlement recipient matches the resolved counterparty:
--
--   1. ledger_counterparties.onchain_address — the payee's on-chain address (the
--      address Brain has on file for an agent/wallet counterparty). The gate
--      compares the intent's settlement recipient against THIS.
--   2. ledger_payment_intents.settlement_pay_to — the recipient carried on the
--      x402 PaymentIntent (the address from the x402 paymentRequirements). Only
--      meaningful for action_type='x402_settle'; a cross-column CHECK enforces
--      that it is null for every other action type and a 0x address for x402.
--
-- No PII on-chain (RFC 0001 §3): an EVM address is a public on-chain identifier,
-- not customer PII. Both columns nullable + additive; no data rewrite.

BEGIN;

ALTER TABLE ledger_counterparties
  ADD COLUMN IF NOT EXISTS onchain_address TEXT;

ALTER TABLE ledger_counterparties
  DROP CONSTRAINT IF EXISTS ledger_counterparties_onchain_address_check;

ALTER TABLE ledger_counterparties
  ADD CONSTRAINT ledger_counterparties_onchain_address_check
  CHECK (onchain_address IS NULL OR onchain_address ~ '^0x[0-9a-fA-F]{40}$');

COMMENT ON COLUMN ledger_counterparties.onchain_address IS
  'Payee on-chain (EVM) address for x402/on-chain settlement; null for off-chain. RFC 0001 §6.1.';

ALTER TABLE ledger_payment_intents
  ADD COLUMN IF NOT EXISTS settlement_pay_to TEXT;

ALTER TABLE ledger_payment_intents
  DROP CONSTRAINT IF EXISTS ledger_payment_intents_settlement_pay_to_check;

ALTER TABLE ledger_payment_intents
  ADD CONSTRAINT ledger_payment_intents_settlement_pay_to_check
  CHECK (
    settlement_pay_to IS NULL
    OR (action_type = 'x402_settle' AND settlement_pay_to ~ '^0x[0-9a-fA-F]{40}$')
  );

COMMENT ON COLUMN ledger_payment_intents.settlement_pay_to IS
  'x402 settlement recipient address (from the x402 paymentRequirements); null unless action_type=x402_settle. RFC 0001 §6.1.';

COMMIT;
