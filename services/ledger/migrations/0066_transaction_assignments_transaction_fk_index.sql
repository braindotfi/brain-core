-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_tx_assignments_transaction_fk ON ledger_transaction_category_assignments (transaction_id);
