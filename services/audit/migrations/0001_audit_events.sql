-- Brain audit_events table.
--
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 5.
-- Owner: services/audit. The table ships in stage-1 ahead of the owning
-- service so that stages 2–6 (raw, wiki, policy, execution) can emit
-- audit events from day one. Stage 7 adds audit_anchors and the anchor
-- publisher to this schema.
--
-- Principles enforced here:
--   §1.2 tenant isolation — RLS policy scopes by app.tenant_id
--   §1.4 audit everything  — append-only (no UPDATE / DELETE grants at app role)
--   §5.3 deterministic chain — (tenant_id, event_hash) uniqueness + per-tenant
--         chain via prev_event_hash

BEGIN;

CREATE TABLE IF NOT EXISTS audit_events (
  id                TEXT        PRIMARY KEY,                -- Brain ULID: evt_...
  tenant_id         TEXT        NOT NULL,                   -- tnt_...
  layer             TEXT        NOT NULL
                    CHECK (layer IN ('raw','wiki','policy','execution','audit')),
  actor             TEXT        NOT NULL,                   -- user_/agent_/partner_
  action            TEXT        NOT NULL,
  inputs            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  outputs           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  policy_version    INTEGER,
  event_hash        BYTEA       NOT NULL,                   -- sha256(canonical)
  prev_event_hash   BYTEA,                                   -- per-tenant chain
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- §3 Layer 5 index requirement: (tenant_id, created_at)
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_time
  ON audit_events (tenant_id, created_at DESC, id DESC);

-- A tenant's chain MUST have unique event hashes. Hash collisions would
-- indicate either a duplicate canonical serialization (bug) or a SHA-256
-- collision (we'll accept the risk).
CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_events_tenant_hash
  ON audit_events (tenant_id, event_hash);

-- §1 principle 2: row-level security. The app role reads only its own tenant.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_events
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Insertion also requires the row's tenant_id matches the session scope,
-- with one carve-out: the audit writer role (BYPASSRLS) may insert on
-- behalf of any tenant. That role is granted in stage-8 infrastructure.
CREATE POLICY tenant_isolation_insert ON audit_events
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- Append-only at the data layer. Individual roles may override; the default
-- app role must not.
REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;

COMMIT;
