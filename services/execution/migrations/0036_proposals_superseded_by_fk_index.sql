-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_proposals_superseded_by_fk ON proposals (superseded_by);
