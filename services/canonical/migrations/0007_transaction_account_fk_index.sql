-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_canonical_transaction_account_id_fk ON canonical_transaction (canonical_account_id);
