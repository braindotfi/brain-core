-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_obligations_counterparty_fk ON ledger_obligations (counterparty_id);
