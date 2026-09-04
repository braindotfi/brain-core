-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_payment_intents_invoice_fk ON ledger_payment_intents (invoice_id);
