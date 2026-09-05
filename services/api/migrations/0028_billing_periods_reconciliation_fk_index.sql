-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_api_billing_periods_tenant_reconciliation_fk ON api_billing_periods (tenant_id, reconciliation_run_id);
