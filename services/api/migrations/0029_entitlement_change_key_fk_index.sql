-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_api_entitlement_change_log_key_fk ON api_entitlement_change_log (key_id);
