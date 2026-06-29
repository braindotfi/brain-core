BEGIN;

CREATE TABLE IF NOT EXISTS surface_email_recipients (
  tenant_id    TEXT        NOT NULL,
  email        TEXT        NOT NULL,
  actor_id     TEXT        NOT NULL,
  roles        TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  verified_at  TIMESTAMPTZ,
  status       TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS surface_email_routes (
  tenant_id   TEXT        NOT NULL,
  agent       TEXT        NOT NULL CHECK (agent IN ('invoice','collections','cash','close')),
  recipients  TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent)
);

CREATE TABLE IF NOT EXISTS surface_email_domains (
  tenant_id    TEXT        NOT NULL,
  domain       TEXT        NOT NULL,
  spf_ok       BOOLEAN     NOT NULL DEFAULT false,
  dkim_ok      BOOLEAN     NOT NULL DEFAULT false,
  dmarc_ok     BOOLEAN     NOT NULL DEFAULT false,
  verified_at  TIMESTAMPTZ,
  status       TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, domain)
);

ALTER TABLE surface_email_recipients ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surface_email_recipients
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON surface_email_recipients
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON surface_email_recipients
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE surface_email_recipients FORCE ROW LEVEL SECURITY;

ALTER TABLE surface_email_routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surface_email_routes
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON surface_email_routes
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON surface_email_routes
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE surface_email_routes FORCE ROW LEVEL SECURITY;

ALTER TABLE surface_email_domains ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surface_email_domains
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON surface_email_domains
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON surface_email_domains
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE surface_email_domains FORCE ROW LEVEL SECURITY;

COMMIT;
