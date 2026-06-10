-- Brain Raw -- per-resource, per-object-type sync checkpoints
-- (ingestion architecture §10).
--
-- One cursor per connection is insufficient: a single connection carries
-- several object types, each with its own cadence; one connection cursor
-- loses or re-pulls data on partial failure. Each row here is an
-- independently committed partition: (source, provider resource, object
-- type) with its own checkpoint.
--
-- Invariant (anti-pattern list): a checkpoint NEVER advances before the
-- batch's raw artifacts are durably committed. The sync worker ingests the
-- batch first, then advances committed_checkpoint in a single UPDATE guarded
-- by pending_run_id (the run lease), so a crashed run leaves the checkpoint
-- untouched and the retry re-pulls the same batch idempotently (envelope
-- idempotency_key + content hash absorb the replay).

BEGIN;

CREATE TABLE IF NOT EXISTS raw_sync_partitions (
  id                      TEXT        PRIMARY KEY,            -- Brain ULID: spart_...
  tenant_id               TEXT        NOT NULL,
  source_id               TEXT        NOT NULL,                -- raw_sources.id (connection)
  resource_id             TEXT        NOT NULL DEFAULT '',     -- provider resource (item, company, mailbox); '' = whole connection
  object_type             TEXT        NOT NULL,                -- provider object type (transaction, balance, invoice, ...)
  checkpoint_type         TEXT        NOT NULL
                          CHECK (checkpoint_type IN ('cursor','page_token','watermark','snapshot')),
  committed_checkpoint    JSONB,                               -- NULL = backfill has not produced a checkpoint yet
  pending_run_id          TEXT,                                -- non-NULL while a sync run holds the lease
  last_successful_sync_at TIMESTAMPTZ,
  backfill_status         TEXT        NOT NULL DEFAULT 'not_started'
                          CHECK (backfill_status IN ('not_started','running','complete','failed')),
  error_message           TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_id, resource_id, object_type)
);

CREATE INDEX IF NOT EXISTS idx_raw_sync_partitions_tenant_source
  ON raw_sync_partitions (tenant_id, source_id);

ALTER TABLE raw_sync_partitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON raw_sync_partitions
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_write ON raw_sync_partitions
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_update ON raw_sync_partitions
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE raw_sync_partitions FORCE ROW LEVEL SECURITY;

COMMIT;
