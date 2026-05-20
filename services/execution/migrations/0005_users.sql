-- Brain tenant users table.
-- Maps authenticated human principals to their approval role within a tenant.
-- Used by makeResolveRole (boot binary) to route payment-intent approvals
-- to the correct human approver when the principal is not an agent.

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id          TEXT        PRIMARY KEY,                 -- usr_...
  tenant_id   TEXT        NOT NULL,
  email       TEXT        NOT NULL,
  role        TEXT        NOT NULL
               CHECK (role IN ('owner', 'admin', 'approver', 'viewer')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_users_tenant
  ON users (tenant_id);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON users
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON users
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
