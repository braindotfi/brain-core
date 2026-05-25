-- H-17 domain event bus (Postgres LISTEN/NOTIFY substrate).
--
-- Runtime fan-out without Kafka/an external broker: producers INSERT a row here
-- and pg_notify('domain_events', <pointer>); long-lived subscribers LISTEN and,
-- on reconnect, catch up from a cursor over this table. Durability of the
-- record-of-truth still lives in the append-only audit log — this table is the
-- decoupling seam for runtime consumers (the agent router subscribes here).
--
-- Co-located in the audit service's migrations (the migrate tool discovers
-- services/<svc>/migrations only). The shared bus module (shared/src/events/bus.ts)
-- writes/reads it under the request tenant scope (RLS), the same cross-cutting
-- pattern as the webhook dead-letter queue.

BEGIN;

CREATE TABLE IF NOT EXISTS domain_events (
  id            TEXT        PRIMARY KEY,                 -- evt_<ulid>
  tenant_id     TEXT        NOT NULL,
  event_type    TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Per-subscriber consumption cursor/marks, e.g. {"agent-router": "<iso ts>"}.
  consumed_by   JSONB       NOT NULL DEFAULT '{}'::JSONB
);

-- Catch-up scan: a subscriber resumes from the last id/created_at it consumed.
CREATE INDEX IF NOT EXISTS idx_domain_events_tenant_created
  ON domain_events (tenant_id, created_at, id);

ALTER TABLE domain_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON domain_events
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON domain_events
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON domain_events
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
