-- Brain Ledger -- admit 'payment_processor' as an account type.
--
-- Phase 3 Stripe connector: a connected processor balance (Stripe) is a real
-- money pool the tenant owns, but it is neither a bank account nor a card.
-- Forcing it into 'bank_checking' would destroy source meaning (ingestion
-- architecture §12: preserve domain semantics). Additive CHECK widening;
-- existing rows are untouched.

BEGIN;

ALTER TABLE ledger_accounts DROP CONSTRAINT IF EXISTS ledger_accounts_account_type_check;
ALTER TABLE ledger_accounts
  ADD CONSTRAINT ledger_accounts_account_type_check
  CHECK (account_type IN (
    'bank_checking','bank_savings','card','loan',
    'line_of_credit','onchain','payment_processor'
  ));

COMMIT;
