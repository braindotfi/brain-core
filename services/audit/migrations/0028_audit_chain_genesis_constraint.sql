-- brain-migration: no-transaction
CREATE UNIQUE INDEX CONCURRENTLY uq_audit_events_one_genesis_per_tenant
  ON audit_events (tenant_id)
  WHERE prev_event_hash IS NULL;
