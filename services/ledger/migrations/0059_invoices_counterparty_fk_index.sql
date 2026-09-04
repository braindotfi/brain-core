-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_invoices_counterparty_fk ON ledger_invoices (counterparty_id);
