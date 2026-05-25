-- Brain raw_sources table.
-- Persistent source-connector store for the /v1/sources/* lifecycle.
-- Credentials are AES-256-GCM encrypted (BYTEA NULL for public-key sources
-- such as wallet addresses). Owner: services/raw.

BEGIN;

CREATE TABLE raw_sources (
  id                    TEXT        PRIMARY KEY,             -- Brain ULID: src_...
  tenant_id             TEXT        NOT NULL,
  type                  TEXT        NOT NULL
                        CHECK (type IN (
                          'plaid','stripe','netsuite','email_inbound',
                          'csv_upload','pdf_upload','alchemy_wallet','eth_address'
                        )),
  status                TEXT        NOT NULL
                        CHECK (status IN ('active','paused','error','disconnected')),
  encrypted_credentials BYTEA,                              -- NULL for public-credential sources
  credential_key_id     TEXT,                               -- key rotation label
  metadata              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  external_account_ids  TEXT[]      NOT NULL DEFAULT '{}',  -- ledger external_account_id values
  last_synced_at        TIMESTAMPTZ,
  error_message         TEXT,
  is_stub               BOOLEAN     NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_raw_sources_tenant_status
  ON raw_sources (tenant_id, status);

CREATE INDEX idx_raw_sources_tenant_type
  ON raw_sources (tenant_id, type);

CREATE INDEX idx_raw_sources_external_account_ids
  ON raw_sources USING GIN (external_account_ids);

ALTER TABLE raw_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON raw_sources
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_write ON raw_sources
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_update ON raw_sources
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
