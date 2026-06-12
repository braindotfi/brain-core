-- Brain Ledger -- counterparty entity resolution (ingestion architecture
-- Phase 4, §11 "Resolved" / §13).
--
-- The same real-world organization is observed under several counterparty
-- rows: Plaid lands "Acme Industrial Supply" as a merchant, the accounting
-- aggregator as a vendor, Stripe as a customer. Resolution LINKS those
-- observations through ledger_reconciliation_matches (counterparty entity
-- sides, match_type counterparty_duplicate) -- never destructively merges
-- them, and weak matches wait as duplicate_possible candidates for user
-- review. Additive CHECK widenings only.

BEGIN;

ALTER TABLE ledger_reconciliation_matches DROP CONSTRAINT IF EXISTS ledger_reconciliation_matches_match_type_check;
ALTER TABLE ledger_reconciliation_matches
  ADD CONSTRAINT ledger_reconciliation_matches_match_type_check
  CHECK (match_type IN (
    'transaction_receipt','invoice_payment','statement_balance',
    'wallet_transfer','payroll_bank_debit','subscription_charge',
    'card_charge','onchain_settlement','obligation_duplicate',
    'counterparty_duplicate'
  ));

ALTER TABLE ledger_reconciliation_matches DROP CONSTRAINT IF EXISTS ledger_reconciliation_matches_left_entity_type_check;
ALTER TABLE ledger_reconciliation_matches
  ADD CONSTRAINT ledger_reconciliation_matches_left_entity_type_check
  CHECK (left_entity_type IN (
    'transaction','invoice','obligation','document','balance','transfer','counterparty'
  ));

ALTER TABLE ledger_reconciliation_matches DROP CONSTRAINT IF EXISTS ledger_reconciliation_matches_right_entity_type_check;
ALTER TABLE ledger_reconciliation_matches
  ADD CONSTRAINT ledger_reconciliation_matches_right_entity_type_check
  CHECK (right_entity_type IN (
    'transaction','invoice','obligation','document','balance','transfer','counterparty'
  ));

COMMIT;
