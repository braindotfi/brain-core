-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_api_usage_daily_rollups_key_fk ON api_usage_daily_rollups (key_id);
