-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_api_billing_adjustments_tenant_period_fk ON api_billing_adjustments (tenant_id, billing_period_id);
