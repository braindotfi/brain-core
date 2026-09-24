BEGIN;

CREATE TABLE IF NOT EXISTS tenant_integrations (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  adapter_kind TEXT NOT NULL CHECK (adapter_kind IN (
    'ofac',
    'pep',
    'kyc',
    'card_issuer',
    'dispute',
    'reversal',
    'directory',
    'saas_vendor',
    'llm',
    'notification',
    'blob'
  )),
  provider TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, adapter_kind)
);

CREATE INDEX IF NOT EXISTS idx_tenant_integrations_enabled
  ON tenant_integrations (tenant_id, adapter_kind, provider)
  WHERE enabled = TRUE;

ALTER TABLE tenant_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_integrations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_integrations_tenant_read ON tenant_integrations
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_integrations_tenant_insert ON tenant_integrations
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_integrations_tenant_update ON tenant_integrations
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
