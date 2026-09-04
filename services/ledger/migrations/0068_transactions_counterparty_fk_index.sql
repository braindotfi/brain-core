-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_transactions_counterparty_fk ON ledger_transactions (counterparty_id);
