-- RFC 0010 Phase 1: tenant graduation verification, versioned evidence,
-- explainable assessments, and append-only manual review decisions.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_graduation_requests (
  id                    TEXT        NOT NULL,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  idempotency_key       TEXT        NOT NULL,
  profile_hash          TEXT        NOT NULL,
  initiated_by_member_id TEXT       NOT NULL,
  verification_policy_version TEXT  NOT NULL,
  status                TEXT        NOT NULL CHECK (
    status IN (
      'evaluating',
      'clear',
      'manual_review',
      'needs_information',
      'blocked',
      'verification_error',
      'cancelled'
    )
  ),
  version               INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_graduation_active_request
  ON tenant_graduation_requests (tenant_id)
  WHERE status NOT IN ('blocked', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_tenant_graduation_status
  ON tenant_graduation_requests (tenant_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS tenant_graduation_evidence (
  id                    TEXT        NOT NULL,
  tenant_id             TEXT        NOT NULL,
  request_id            TEXT        NOT NULL,
  evidence_version      INTEGER     NOT NULL CHECK (evidence_version > 0),
  evidence_type         TEXT        NOT NULL CHECK (evidence_type IN ('business_profile')),
  payload               JSONB       NOT NULL,
  submitted_by_member_id TEXT       NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, request_id, evidence_version),
  FOREIGN KEY (tenant_id, request_id)
    REFERENCES tenant_graduation_requests(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS tenant_graduation_assessments (
  id                    TEXT        NOT NULL,
  tenant_id             TEXT        NOT NULL,
  request_id            TEXT        NOT NULL,
  verification_policy_version TEXT  NOT NULL,
  outcome               TEXT        NOT NULL CHECK (
    outcome IN ('clear', 'manual_review', 'needs_information', 'blocked')
  ),
  signals               JSONB       NOT NULL,
  assessed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, request_id, verification_policy_version),
  FOREIGN KEY (tenant_id, request_id)
    REFERENCES tenant_graduation_requests(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS tenant_graduation_review_decisions (
  id                    TEXT        NOT NULL,
  tenant_id             TEXT        NOT NULL,
  request_id            TEXT        NOT NULL,
  assessment_id         TEXT        NOT NULL,
  decision              TEXT        NOT NULL CHECK (
    decision IN ('clear', 'needs_information', 'blocked')
  ),
  reason_code           TEXT        NOT NULL,
  reviewer_id           TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id)
    REFERENCES tenant_graduation_requests(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, assessment_id)
    REFERENCES tenant_graduation_assessments(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_tenant_graduation_evidence_request
  ON tenant_graduation_evidence (tenant_id, request_id, evidence_version DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_graduation_assessment_request
  ON tenant_graduation_assessments (tenant_id, request_id, assessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_graduation_review_request
  ON tenant_graduation_review_decisions (tenant_id, request_id, created_at DESC);

ALTER TABLE tenant_graduation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_graduation_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_graduation_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_graduation_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_graduation_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_graduation_assessments FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_graduation_review_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_graduation_review_decisions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_graduation_requests_tenant_access ON tenant_graduation_requests
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_graduation_evidence_tenant_access ON tenant_graduation_evidence
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_graduation_assessments_tenant_access ON tenant_graduation_assessments
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_graduation_reviews_tenant_access ON tenant_graduation_review_decisions
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

REVOKE UPDATE, DELETE, TRUNCATE ON tenant_graduation_evidence,
  tenant_graduation_assessments, tenant_graduation_review_decisions FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    GRANT SELECT, INSERT, UPDATE ON tenant_graduation_requests TO brain_app;
    GRANT SELECT, INSERT ON tenant_graduation_evidence,
      tenant_graduation_assessments TO brain_app;
    GRANT SELECT ON tenant_graduation_review_decisions TO brain_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON tenant_graduation_evidence,
      tenant_graduation_assessments, tenant_graduation_review_decisions FROM brain_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_privileged') THEN
    GRANT SELECT, INSERT, UPDATE ON tenant_graduation_requests TO brain_privileged;
    GRANT SELECT, INSERT ON tenant_graduation_evidence,
      tenant_graduation_assessments, tenant_graduation_review_decisions TO brain_privileged;
  END IF;
END $$;

COMMENT ON TABLE tenant_graduation_requests IS
  'RFC 0010 demo-to-production verification workflow. This row never converts the source tenant in place.';
COMMENT ON TABLE tenant_graduation_evidence IS
  'Versioned business evidence. Payload access is restricted to the tenant-scoped graduation service.';
COMMENT ON TABLE tenant_graduation_assessments IS
  'Immutable explainable verification outcomes produced by a versioned pluggable policy.';
COMMENT ON TABLE tenant_graduation_review_decisions IS
  'Append-only manual-review decisions. No member-session mutation route is granted.';

-- Cross-service member foreign keys are installed by execution migration 0035.
-- The global migrator applies every api migration before execution creates
-- members, so declaring those references here breaks a fresh database.

COMMIT;
