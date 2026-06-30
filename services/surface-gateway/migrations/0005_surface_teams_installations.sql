BEGIN;

CREATE TABLE IF NOT EXISTS surface_teams_installations (
  brain_tenant_id  TEXT        NOT NULL,
  aad_tenant_id    TEXT        NOT NULL,
  service_url      TEXT,
  installed_by     TEXT        NOT NULL,
  installed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ,
  status           TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  revoked_at       TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (brain_tenant_id, aad_tenant_id),
  UNIQUE (aad_tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_surface_teams_installations_brain_tenant
  ON surface_teams_installations (brain_tenant_id)
  WHERE status = 'active';

ALTER TABLE surface_teams_installations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surface_teams_installations
  USING (
    brain_tenant_id = current_setting('app.tenant_id', true)
    OR aad_tenant_id = current_setting('app.teams_aad_tenant_id', true)
  );
CREATE POLICY tenant_isolation_write ON surface_teams_installations
  FOR INSERT WITH CHECK (brain_tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON surface_teams_installations
  FOR UPDATE USING (
    brain_tenant_id = current_setting('app.tenant_id', true)
    OR aad_tenant_id = current_setting('app.teams_aad_tenant_id', true)
  )
  WITH CHECK (
    brain_tenant_id = current_setting('app.tenant_id', true)
    OR aad_tenant_id = current_setting('app.teams_aad_tenant_id', true)
  );
ALTER TABLE surface_teams_installations FORCE ROW LEVEL SECURITY;

COMMIT;
