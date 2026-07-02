-- Members, approval authority, and actor attribution.
--
-- `users` remains the authentication/login table. `members` is the tenant
-- approval-authority table used by approve paths and surface actor attribution.
-- The upgrade backfill preserves current behavior by promoting existing users
-- to active admin members with every approval domain and a high per-item limit.
-- Member rows are never hard-deleted: application DELETE is intentionally not
-- granted by RLS policy. Deactivation is represented by active=false so audit
-- continuity and historical approval attribution remain intact.

BEGIN;

CREATE TABLE IF NOT EXISTS members (
  tenant_id                                  TEXT        NOT NULL,
  id                                         TEXT        NOT NULL,
  email                                      TEXT        NOT NULL,
  display_name                               TEXT        NOT NULL,
  role                                       TEXT        NOT NULL
                                                   CHECK (role IN ('admin', 'approver', 'viewer')),
  active                                     BOOLEAN     NOT NULL DEFAULT true,
  approval_domains                           TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[]
                                                   CHECK (
                                                     approval_domains <@ ARRAY[
                                                       'ap',
                                                       'ar',
                                                       'treasury',
                                                       'payroll',
                                                       'reconciliation'
                                                     ]::TEXT[]
                                                   ),
  per_item_limit_cents                       BIGINT      NOT NULL
                                                   CHECK (per_item_limit_cents >= 0),
  requires_second_approver_above_cents       BIGINT
                                                   CHECK (
                                                     requires_second_approver_above_cents IS NULL
                                                     OR requires_second_approver_above_cents >= 0
                                                   ),
  created_at                                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_members_tenant_role
  ON members (tenant_id, role);

CREATE INDEX IF NOT EXISTS idx_members_tenant_active
  ON members (tenant_id, active);

CREATE TABLE IF NOT EXISTS member_identity_links (
  tenant_id     TEXT        NOT NULL,
  member_id     TEXT        NOT NULL,
  surface       TEXT        NOT NULL CHECK (surface IN ('slack', 'teams', 'email')),
  external_ref  TEXT        NOT NULL,
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, surface, external_ref),
  FOREIGN KEY (tenant_id, member_id)
    REFERENCES members (tenant_id, id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_member_identity_links_surface_external_ref
  ON member_identity_links (surface, external_ref);

CREATE INDEX IF NOT EXISTS idx_member_identity_links_member
  ON member_identity_links (tenant_id, member_id);

-- Existing authenticated identities become admin members on upgrade. Owners
-- map to admin because the members contract uses admin/approver/viewer only.
-- The high limit preserves existing approval behavior until tenants configure
-- stricter member limits.
INSERT INTO members (
  tenant_id,
  id,
  email,
  display_name,
  role,
  active,
  approval_domains,
  per_item_limit_cents,
  requires_second_approver_above_cents,
  created_at,
  updated_at
)
SELECT
  users.tenant_id,
  users.id,
  lower(users.email),
  users.email,
  CASE WHEN users.role IN ('owner', 'admin') THEN 'admin' ELSE users.role END,
  CASE WHEN COALESCE(users.status, 'active') = 'disabled' THEN false ELSE true END,
  ARRAY['ap', 'ar', 'treasury', 'payroll', 'reconciliation']::TEXT[],
  9223372036854775807,
  NULL::BIGINT,
  users.created_at,
  now()
FROM users
WHERE users.email IS NOT NULL
ON CONFLICT (tenant_id, id) DO NOTHING;

ALTER TABLE members ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON members
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON members
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON members
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE member_identity_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON member_identity_links
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON member_identity_links
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON member_identity_links
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE members FORCE ROW LEVEL SECURITY;
ALTER TABLE member_identity_links FORCE ROW LEVEL SECURITY;

COMMIT;
