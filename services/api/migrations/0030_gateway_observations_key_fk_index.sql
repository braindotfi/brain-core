-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_api_gateway_observations_tenant_key_fk ON api_gateway_request_observations (tenant_id, key_id);
