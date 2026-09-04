-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_payment_intents_source_account_fk ON ledger_payment_intents (source_account_id);
