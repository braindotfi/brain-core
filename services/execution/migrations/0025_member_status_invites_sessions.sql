-- Production tenancy contract: invited members, platform identity links,
-- invite tokens, and refresh-token rotation state.

BEGIN;

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS status TEXT;

UPDATE members
   SET status = CASE WHEN active THEN 'active' ELSE 'deactivated' END
 WHERE status IS NULL;

ALTER TABLE members
  ALTER COLUMN status SET DEFAULT 'active',
  ALTER COLUMN status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'members_status_check'
       AND conrelid = 'members'::regclass
  ) THEN
    ALTER TABLE members
      ADD CONSTRAINT members_status_check CHECK (status IN ('invited', 'active', 'deactivated'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_members_tenant_status
  ON members (tenant_id, status);

ALTER TABLE member_identity_links
  DROP CONSTRAINT IF EXISTS member_identity_links_surface_check;

ALTER TABLE member_identity_links
  ADD CONSTRAINT member_identity_links_surface_check
  CHECK (surface IN ('slack', 'teams', 'email', 'platform'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_member_identity_links_platform_external_ref_unique
  ON member_identity_links (surface, external_ref)
  WHERE surface = 'platform';

CREATE TABLE IF NOT EXISTS member_invites (
  tenant_id     TEXT        NOT NULL,
  member_id     TEXT        NOT NULL,
  token_hash    TEXT        NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  issued_by     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, token_hash),
  FOREIGN KEY (tenant_id, member_id)
    REFERENCES members (tenant_id, id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_member_invites_outstanding_member
  ON member_invites (tenant_id, member_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_member_invites_member
  ON member_invites (tenant_id, member_id);

CREATE INDEX IF NOT EXISTS idx_member_invites_token_hash
  ON member_invites (token_hash);

ALTER TABLE member_invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON member_invites
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON member_invites
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON member_invites
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE member_invites FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS session_refresh_tokens (
  tenant_id    TEXT        NOT NULL,
  member_id    TEXT        NOT NULL,
  token_hash   TEXT        PRIMARY KEY,
  family_id    TEXT        NOT NULL,
  token_id     TEXT        NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  rotated_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, member_id)
    REFERENCES members (tenant_id, id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_session_refresh_tokens_family
  ON session_refresh_tokens (tenant_id, family_id);

CREATE INDEX IF NOT EXISTS idx_session_refresh_tokens_member
  ON session_refresh_tokens (tenant_id, member_id);

ALTER TABLE session_refresh_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON session_refresh_tokens
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON session_refresh_tokens
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON session_refresh_tokens
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE session_refresh_tokens FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN members.status IS
  'Production member lifecycle: invited | active | deactivated. active remains as a compatibility mirror.';
COMMENT ON TABLE member_invites IS
  'Single-use hashed invite tokens for activating invited members into one existing tenant.';
COMMENT ON TABLE session_refresh_tokens IS
  'Hashed refresh tokens with rotation and family revocation for production member sessions.';

COMMIT;
