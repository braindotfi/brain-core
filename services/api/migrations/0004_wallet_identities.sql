-- RFC 0002 Phase D: wallet ↔ tenant identity links.
--
-- Lets SIWX resolve a wallet address to a (tenant, principal) for BOTH humans
-- (owner login via wallet) and agents — today only agents resolve, via the
-- PostgresAgentRegistry address→agent lookup. A row here says "this wallet is
-- principal P (human user / agent) of tenant T".
--
-- FK-less by design (Brain relies on app-level integrity + RLS, like users /
-- agents — neither FKs tenants). Only `tenant_id` drives RLS. With no FK there is
-- no cross-service migration-ordering dependency, so this `api/*` migration
-- applies cleanly even though it runs before the execution/* migrations that
-- create users/agents (cf. the 0003 ordering note).
--
-- The PRIMARY KEY on `address` makes a wallet GLOBALLY single-homed: one wallet
-- maps to exactly one (tenant, principal), so SIWX resolution is deterministic
-- and a wallet cannot be claimed by two tenants. A second link attempt hits the
-- PK and surfaces as wallet_already_linked (409). Unique-index/PK enforcement
-- sits beneath RLS, so the cross-tenant guarantee holds.

BEGIN;

CREATE TABLE IF NOT EXISTS wallet_identities (
  address        TEXT        PRIMARY KEY,                        -- lowercased 0x… address (globally unique)
  tenant_id      TEXT        NOT NULL,
  principal_type TEXT        NOT NULL CHECK (principal_type IN ('human', 'agent')),
  principal_id   TEXT        NOT NULL,                           -- user_… (human) or agent_… (agent)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_identities_tenant
  ON wallet_identities (tenant_id);

COMMENT ON TABLE wallet_identities IS
  'Wallet address → (tenant, principal) link for SIWX resolution of humans + agents (RFC 0002 Phase D). Address is globally single-homed (PK).';

ALTER TABLE wallet_identities ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON wallet_identities
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON wallet_identities
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON wallet_identities
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
