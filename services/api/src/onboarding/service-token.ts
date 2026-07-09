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
import { newPolicyId, newUserId } from "@brain/shared";
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
