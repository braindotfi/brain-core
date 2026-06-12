-- Brain Ledger -- resolution-stage match types (ingestion architecture Phase 4).
--
-- Two additions to the match_type CHECK:
--   - obligation_duplicate: two observations of the same real-world payable
--     from different sources (document tier vs accounting aggregator). The
--     resolution stage links them with a match row -- observations preserved,
--     never destructively merged (§11 "Resolved", §13).
--   - onchain_settlement: latent CHECK violation fix. The matcher
--     (reconciliation/onchain-settlement.ts) has written this value since it
--     shipped, but 0011's CHECK never admitted it, so every live insert
--     failed. Unit tests use fake pools and never caught it.

BEGIN;

ALTER TABLE ledger_reconciliation_matches DROP CONSTRAINT IF EXISTS ledger_reconciliation_matches_match_type_check;
ALTER TABLE ledger_reconciliation_matches
  ADD CONSTRAINT ledger_reconciliation_matches_match_type_check
  CHECK (match_type IN (
    'transaction_receipt','invoice_payment','statement_balance',
    'wallet_transfer','payroll_bank_debit','subscription_charge',
    'card_charge','onchain_settlement','obligation_duplicate'
  ));

COMMIT;
