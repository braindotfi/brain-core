-- brain-migration: no-transaction
CREATE UNIQUE INDEX CONCURRENTLY uq_audit_events_one_successor_per_predecessor
  ON audit_events (tenant_id, prev_event_hash)
  WHERE prev_event_hash IS NOT NULL;
