-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_extraction_jobs_raw_fk ON extraction_jobs (raw_id);
