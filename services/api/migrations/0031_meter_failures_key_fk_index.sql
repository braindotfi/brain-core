-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_api_meter_failures_tenant_key_fk ON api_meter_persistence_failure_events (tenant_id, key_id);
