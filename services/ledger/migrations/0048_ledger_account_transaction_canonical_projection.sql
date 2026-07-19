-- Link connector-sourced canonical accounts and transactions to their Ledger projections.

BEGIN;

ALTER TABLE ledger_accounts
  ADD COLUMN IF NOT EXISTS canonical_account_id TEXT;

ALTER TABLE ledger_transactions
  ADD COLUMN IF NOT EXISTS canonical_transaction_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_accounts_owner_canonical_account
  ON ledger_accounts (owner_id, canonical_account_id)
  WHERE canonical_account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_transactions_owner_canonical_transaction
  ON ledger_transactions (owner_id, canonical_transaction_id)
  WHERE canonical_transaction_id IS NOT NULL;

COMMIT;
