-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_transfers_to_transaction_fk ON ledger_transfers (to_transaction_id);
