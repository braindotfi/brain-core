-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_transfers_from_transaction_fk ON ledger_transfers (from_transaction_id);
