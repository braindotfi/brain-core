-- RFC 0010 Phase 2: unpaid fresh-tenant graduation and immutable lineage.

BEGIN;

ALTER TABLE tenant_graduation_requests
  DROP CONSTRAINT IF EXISTS tenant_graduation_requests_status_check;

ALTER TABLE tenant_graduation_requests
  ADD CONSTRAINT tenant_graduation_requests_status_check CHECK (
    status IN (
      'evaluating',
      'clear',
      'manual_review',
      'needs_information',
      'blocked',
      'verification_error',
      'graduating',
      'graduated',
      'cancelled'
    )
  ),
  ADD COLUMN IF NOT EXISTS reserved_destination_tenant_id TEXT,
  ADD COLUMN IF NOT EXISTS reserved_destination_member_id TEXT,
  ADD COLUMN IF NOT EXISTS provisioning_idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS graduated_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_graduation_destination
  ON tenant_graduation_requests (reserved_destination_tenant_id)
  WHERE reserved_destination_tenant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tenant_graduation_lineage (
  id                    TEXT        NOT NULL,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  request_id            TEXT        NOT NULL,
  destination_tenant_id TEXT        NOT NULL,
  destination_member_id TEXT        NOT NULL,
  graduation_mode       TEXT        NOT NULL CHECK (graduation_mode IN ('unpaid')),
  copied_fields         JSONB       NOT NULL,
  excluded_data_classes TEXT[]      NOT NULL,
  financial_data_copied BOOLEAN     NOT NULL DEFAULT FALSE
                                   CHECK (financial_data_copied = FALSE),
  source_classification JSONB       NOT NULL,
  destination_classification JSONB  NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, request_id),
  UNIQUE (destination_tenant_id),
  FOREIGN KEY (tenant_id, request_id)
    REFERENCES tenant_graduation_requests(tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE tenant_graduation_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_graduation_lineage FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_graduation_lineage_tenant_access ON tenant_graduation_lineage
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

REVOKE UPDATE, DELETE, TRUNCATE ON tenant_graduation_lineage FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    GRANT SELECT, INSERT ON tenant_graduation_lineage TO brain_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON tenant_graduation_lineage FROM brain_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_privileged') THEN
    GRANT SELECT, INSERT ON tenant_graduation_lineage TO brain_privileged;
  END IF;
END $$;

COMMENT ON TABLE tenant_graduation_lineage IS
  'Immutable RFC 0010 source-demo to fresh-production relationship. No financial data is copied.';
COMMENT ON COLUMN tenant_graduation_lineage.copied_fields IS
  'Server-owned allowlist of reviewed business and bootstrap-member fields carried into the destination.';
COMMENT ON COLUMN tenant_graduation_lineage.excluded_data_classes IS
  'Explicit evidence that synthetic and tenant-secret data classes were excluded from graduation.';

COMMIT;
