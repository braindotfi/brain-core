BEGIN;

CREATE TABLE IF NOT EXISTS nylas_grants (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook', 'imap')),
  email TEXT NOT NULL,
  scope TEXT[] NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ
);

ALTER TABLE nylas_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE nylas_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY nylas_grants_tenant_read ON nylas_grants
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY nylas_grants_tenant_insert ON nylas_grants
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY nylas_grants_tenant_update ON nylas_grants
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY nylas_grants_tenant_delete ON nylas_grants
  FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
