BEGIN;

DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT conname INTO con_name
    FROM pg_constraint
   WHERE conrelid = 'users'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%role IN%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('owner', 'admin', 'approver', 'analyst', 'viewer'));

UPDATE users
   SET role = 'owner'
 WHERE role = 'admin'
   AND id IN (
     SELECT DISTINCT ON (tenant_id) id
       FROM users
      ORDER BY tenant_id, created_at ASC, id ASC
   );

DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT conname INTO con_name
    FROM pg_constraint
   WHERE conrelid = 'members'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%role IN%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE members DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE members
  ADD CONSTRAINT members_role_check
  CHECK (role IN ('owner', 'admin', 'approver', 'analyst', 'viewer'));

UPDATE members
   SET role = 'owner'
 WHERE role = 'admin'
   AND id IN (
     SELECT DISTINCT ON (tenant_id) id
       FROM members
      WHERE status = 'active'
      ORDER BY tenant_id, created_at ASC, id ASC
   );

DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT conname INTO con_name
    FROM pg_constraint
   WHERE conrelid = 'proposals'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%status IN%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE proposals DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE proposals
  ADD CONSTRAINT proposals_status_check
  CHECK (status IN (
    'pending',
    'approved',
    'acknowledged',
    'reconciling',
    'rejected',
    'executed',
    'failed',
    'undone',
    'superseded',
    'blocked',
    'unknown'
  ));

CREATE TABLE IF NOT EXISTS user_agent_authority (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent TEXT NOT NULL CHECK (agent IN (
    'fraud_anomaly',
    'vendor_risk',
    'dispute',
    'aml_compliance',
    'payment',
    'collections',
    'treasury',
    'subscription_management',
    'invoice_integrity',
    'reconciliation',
    'cash_forecast',
    'revenue_intel'
  )),
  can_approve BOOLEAN NOT NULL DEFAULT true,
  can_edit BOOLEAN NOT NULL DEFAULT true,
  can_reject BOOLEAN NOT NULL DEFAULT true,
  max_amount_cents BIGINT CHECK (max_amount_cents IS NULL OR max_amount_cents >= 0),
  can_delegate BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, agent),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES members (tenant_id, id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_user_agent_authority_tenant_user
  ON user_agent_authority (tenant_id, user_id);

CREATE TABLE IF NOT EXISTS pending_invites (
  tenant_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'approver', 'analyst', 'viewer')),
  agent_authority JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  issued_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, token_hash),
  FOREIGN KEY (tenant_id, member_id)
    REFERENCES members (tenant_id, id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_invites_outstanding_member
  ON pending_invites (tenant_id, member_id)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pending_invites_token_hash
  ON pending_invites (token_hash);

ALTER TABLE user_agent_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_agent_authority FORCE ROW LEVEL SECURITY;
CREATE POLICY user_agent_authority_tenant_read ON user_agent_authority
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY user_agent_authority_tenant_insert ON user_agent_authority
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY user_agent_authority_tenant_update ON user_agent_authority
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY user_agent_authority_tenant_delete ON user_agent_authority
  FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE pending_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_invites FORCE ROW LEVEL SECURITY;
CREATE POLICY pending_invites_tenant_read ON pending_invites
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY pending_invites_tenant_insert ON pending_invites
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY pending_invites_tenant_update ON pending_invites
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
