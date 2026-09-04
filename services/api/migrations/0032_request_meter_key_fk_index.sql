-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_api_request_meter_events_key_fk ON api_request_meter_events (key_id);
