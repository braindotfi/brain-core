/**
 * Mint-side effects for POST /v1/auth/service-token (the BFF service-token
 * route in main.ts). Extracted so the tenant/member/policy bootstrap can be
 * unit tested with a fake pool, the same way provision.ts is tested.
 *
 * H1 fix: the route used to only INSERT tenants + agents, which left a
 * zero-member, zero-policy tenant. That tenant never has an active bootstrap
 * admin member (members.tenant_id FKs to users, so a member needs a users
 * row first) and never has an active policy, so every §6 gate check and every
 * approval-authority check for it fails or free-passes in the wrong way.
 * `ensureTenantBootstrapped` mirrors provisionTenant (provision.ts:150-182):
 * on first tenant creation, in the SAME withTenantScope transaction, it
 * inserts a placeholder owner `users` row, the bootstrap admin member via the
 * shared `insertBootstrapAdminMember` helper, and the active default policy
 * via the shared `buildDefaultPolicyDocument`. This owner member is the
 * tenant's human owner and is separate from the payment agent the route also
 * creates; the minted token still authenticates the agent only.
 *
 * Production fence: this endpoint is a break-glass sandbox/testnet BFF
 * credential, not per-user auth. It is controlled by
 * `BRAIN_SERVICE_TOKEN_ENABLED`, defaults off behind the testnet attestation
 * fence, and must stay disabled for live-money or multi-customer production
 * because the shared secret is not bound to an individual tenant operator.
 */

import type { TenantScopedClient, Scope } from "@brain/shared";
import {
  computeAgentScopeHash,
  newAgentId,
  newPolicyId,
  newTokenId,
  newUserId,
  PAYMENT_AGENT_SCOPES,
} from "@brain/shared";
import { contentHash } from "@brain/policy";
import { insertBootstrapAdminMember, bootstrapPlaceholderEmail } from "./bootstrap-member.js";
import { buildDefaultPolicyDocument } from "./provision.js";

/**
 * M1: minted scope ceiling for POST /v1/auth/service-token. Reads + propose
 * only. payment_intent:approve is deliberately excluded: approval authority
 * belongs to a human member, never to this agent-typed token. Exported as a
 * single source of truth so main.ts and this module's tests cannot drift.
 */
export const SERVICE_TOKEN_SCOPES: readonly Scope[] = [
  "ledger:read",
  "wiki:read",
  "raw:read",
  "raw:write",
  "policy:read",
  "execution:read",
  "execution:propose",
  "payment_intent:propose",
  "audit:read",
];

export const BFF_SERVICE_AGENT_DISPLAY_NAME = "BFF Service Agent";
export const SERVICE_AGENT_TOKEN_TTL_SECONDS = 60 * 60;

export interface EnsureBffServiceAgentResult {
  agentId: string;
  created: boolean;
}

export interface AgentTokenSeed {
  tenantId: string;
  agentId: string;
  tokenId: string;
  expiresAt: number;
}

interface ActiveTokenRow {
  id: string;
  expires_at_epoch: string | number;
}

/**
 * Idempotently seed the owner user, bootstrap admin member, and active
 * default policy for a service-token tenant. Safe to call on every mint:
 * `ON CONFLICT DO NOTHING` on the tenant insert means this only runs its
 * inserts meaningfully once; on repeat calls the member/user/policy inserts
 * also no-op (unique tenant_id+id / tenant_id+state='active' collisions are
 * acceptable no-ops here, mirroring the tenant row's own ON CONFLICT).
 */
export async function ensureTenantBootstrapped(
  c: TenantScopedClient,
  tenantId: string,
): Promise<void> {
  const existingMember = await c.query<{ id: string }>(
    `SELECT id FROM members WHERE tenant_id = $1 AND active = true LIMIT 1`,
    [tenantId],
  );
  if (existingMember.rows[0]) return;

  const ownerUserId = newUserId();
  const placeholderEmail = bootstrapPlaceholderEmail(tenantId);
  // password_hash stays NULL: this owner is approval-only, never a
  // password-login account, so it is excluded from the global
  // users_login_email_unique index (services/execution/0021_users_auth_columns.sql)
  // and cannot collide with a real signup using the same placeholder shape.
  // status defaults to 'active' (no email-verification flow for this row).
  await c.query(
    `INSERT INTO users (id, tenant_id, email, role)
     VALUES ($1, $2, $3, 'owner')
     ON CONFLICT DO NOTHING`,
    [ownerUserId, tenantId, placeholderEmail],
  );
  await insertBootstrapAdminMember(c, {
    tenantId,
    memberId: ownerUserId,
    email: placeholderEmail,
    displayName: "Bootstrap Admin",
  });

  const policyId = newPolicyId();
  const defaultPolicy = buildDefaultPolicyDocument();
  const defaultPolicyHash = contentHash(defaultPolicy);
  await c.query(
    `INSERT INTO policies
       (id, tenant_id, version, content, content_hash, quorum_required, state, created_by, activated_at)
     VALUES ($1, $2, 1, $3, $4, 1, 'active', $5, now())
     ON CONFLICT DO NOTHING`,
    [policyId, tenantId, JSON.stringify(defaultPolicy), defaultPolicyHash, ownerUserId],
  );
}

export async function ensureBffServiceAgent(
  c: TenantScopedClient,
  tenantId: string,
  smartAccount: string,
): Promise<EnsureBffServiceAgentResult> {
  const existing = await c.query<{ id: string }>(
    `SELECT id FROM agents
       WHERE display_name = $1 AND state = 'active'
       ORDER BY created_at ASC LIMIT 1`,
    [BFF_SERVICE_AGENT_DISPLAY_NAME],
  );
  if (existing.rows[0]) return { agentId: existing.rows[0].id, created: false };

  const scopeHash = Buffer.from(computeAgentScopeHash(PAYMENT_AGENT_SCOPES).slice(2), "hex");
  const agentId = newAgentId();
  await c.query(
    `INSERT INTO agents (id, tenant_id, kind, role, display_name, scope_hash, onchain_address, state, registered_at, created_at, contribution_count, quarantine_threshold)
     VALUES ($1, $2, 'internal', 'payment', $3, $4, $5, 'active', now(), now(), 0, 100)`,
    [agentId, tenantId, BFF_SERVICE_AGENT_DISPLAY_NAME, scopeHash, smartAccount],
  );
  return { agentId, created: true };
}

export async function findActiveProductionAgentToken(
  c: TenantScopedClient,
  tenantId: string,
  agentId: string,
): Promise<AgentTokenSeed | null> {
  const { rows } = await c.query<ActiveTokenRow>(
    `SELECT id, extract(epoch from expires_at)::bigint AS expires_at_epoch
       FROM production_agent_tokens
      WHERE tenant_id = $1
        AND agent_id = $2
        AND revoked_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenantId, agentId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    tenantId,
    agentId,
    tokenId: row.id,
    expiresAt: Number(row.expires_at_epoch),
  };
}

export async function insertProductionAgentToken(
  c: TenantScopedClient,
  tenantId: string,
  agentId: string,
  ttlSeconds = SERVICE_AGENT_TOKEN_TTL_SECONDS,
): Promise<AgentTokenSeed> {
  const tokenId = newTokenId();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  await c.query(
    `INSERT INTO production_agent_tokens (id, tenant_id, agent_id, expires_at)
     VALUES ($1, $2, $3, to_timestamp($4))`,
    [tokenId, tenantId, agentId, expiresAt],
  );
  return { tenantId, agentId, tokenId, expiresAt };
}

export async function revokeProductionAgentTokens(
  c: TenantScopedClient,
  tenantId: string,
  agentId: string,
): Promise<AgentTokenSeed[]> {
  const { rows } = await c.query<ActiveTokenRow>(
    `UPDATE production_agent_tokens
        SET revoked_at = now()
      WHERE tenant_id = $1
        AND agent_id = $2
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING id, extract(epoch from expires_at)::bigint AS expires_at_epoch`,
    [tenantId, agentId],
  );
  return rows.map((row) => ({
    tenantId,
    agentId,
    tokenId: row.id,
    expiresAt: Number(row.expires_at_epoch),
  }));
}
