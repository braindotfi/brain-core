-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_payment_intents_obligation_fk ON ledger_payment_intents (obligation_id);
