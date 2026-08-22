-- Brain Raw source lifecycle: represent imported provenance without claiming
-- that a provider connection exists or that a sync can run.

BEGIN;

ALTER TABLE raw_sources DROP CONSTRAINT IF EXISTS raw_sources_status_check;
ALTER TABLE raw_sources
  ADD CONSTRAINT raw_sources_status_check
  CHECK (status IN ('active','paused','error','disconnected','historical'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_sources_seed_identity
  ON raw_sources (tenant_id, (metadata->>'seed_key'), (metadata->>'seed_source_key'))
  WHERE metadata ? 'seed_key' AND metadata ? 'seed_source_key';

COMMIT;
