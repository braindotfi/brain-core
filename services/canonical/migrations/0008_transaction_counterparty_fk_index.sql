-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_canonical_transaction_counterparty_id_fk ON canonical_transaction (canonical_counterparty_id);
