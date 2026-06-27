-- Surface gateway persistence.
-- Owns only webhook and approval-surface state. Money movement stays in
-- execution outbox and rails.

BEGIN;

CREATE TABLE IF NOT EXISTS surface_external_identities (
  tenant_id    TEXT        NOT NULL,
  surface      TEXT        NOT NULL CHECK (surface IN ('slack','teams','email')),
  external_id  TEXT        NOT NULL,
  actor_id     TEXT        NOT NULL,
  roles        TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, surface, external_id)
);

CREATE INDEX IF NOT EXISTS idx_surface_external_identities_actor
  ON surface_external_identities (tenant_id, actor_id);

CREATE TABLE IF NOT EXISTS surface_proposals (
  tenant_id     TEXT        NOT NULL,
  proposal_id   TEXT        NOT NULL,
  proposal      JSONB       NOT NULL,
  content_hash  TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, proposal_id)
);

CREATE TABLE IF NOT EXISTS surface_delivered_refs (
  tenant_id    TEXT        NOT NULL,
  proposal_id  TEXT        NOT NULL,
  surface      TEXT        NOT NULL CHECK (surface IN ('slack','teams','email')),
  target       TEXT        NOT NULL,
  ref          TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, proposal_id, surface, target)
);

CREATE TABLE IF NOT EXISTS surface_decisions (
  tenant_id    TEXT        NOT NULL,
  proposal_id  TEXT        NOT NULL,
  decision     TEXT        NOT NULL CHECK (decision IN ('approved','rejected')),
  actor_id     TEXT        NOT NULL,
  decided_at   TIMESTAMPTZ NOT NULL,
  context      JSONB       NOT NULL DEFAULT '{}'::JSONB,
  applied      BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, proposal_id)
);

CREATE TABLE IF NOT EXISTS surface_slack_retries (
  retry_key   TEXT        PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS surface_teams_conversation_refs (
  tenant_id         TEXT        NOT NULL,
  conversation_ref  TEXT        NOT NULL,
  reference         JSONB       NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_ref)
);

ALTER TABLE surface_external_identities ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surface_external_identities
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON surface_external_identities
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON surface_external_identities
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE surface_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surface_proposals
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON surface_proposals
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON surface_proposals
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE surface_delivered_refs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surface_delivered_refs
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON surface_delivered_refs
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON surface_delivered_refs
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE surface_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surface_decisions
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON surface_decisions
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON surface_decisions
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE surface_teams_conversation_refs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surface_teams_conversation_refs
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON surface_teams_conversation_refs
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON surface_teams_conversation_refs
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
