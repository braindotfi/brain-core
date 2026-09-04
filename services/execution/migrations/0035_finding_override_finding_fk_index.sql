-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_finding_overrides_finding_fk ON agent_finding_overrides (finding_id);
