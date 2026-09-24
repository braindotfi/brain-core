BEGIN;

CREATE TABLE IF NOT EXISTS brief_cache (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brief_date DATE NOT NULL,
  response JSONB NOT NULL,
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, brief_date)
);

CREATE INDEX IF NOT EXISTS idx_brief_cache_tenant_prepared
  ON brief_cache (tenant_id, prepared_at DESC);

CREATE TABLE IF NOT EXISTS robo_threads (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source JSONB,
  payload_snapshot_id UUID,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_robo_threads_tenant_created
  ON robo_threads (tenant_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS robo_messages (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES robo_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  answer JSONB,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_robo_messages_thread_created
  ON robo_messages (tenant_id, thread_id, created_at ASC, id ASC);

ALTER TABLE brief_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE brief_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY brief_cache_tenant_read ON brief_cache
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY brief_cache_tenant_insert ON brief_cache
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY brief_cache_tenant_update ON brief_cache
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE robo_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE robo_threads FORCE ROW LEVEL SECURITY;
CREATE POLICY robo_threads_tenant_read ON robo_threads
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY robo_threads_tenant_insert ON robo_threads
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY robo_threads_tenant_update ON robo_threads
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE robo_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE robo_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY robo_messages_tenant_read ON robo_messages
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY robo_messages_tenant_insert ON robo_messages
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
