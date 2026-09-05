-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_transfers_to_account_fk ON ledger_transfers (to_account_id);
