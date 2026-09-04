-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_payment_intents_destination_fk ON ledger_payment_intents (destination_counterparty_id);
