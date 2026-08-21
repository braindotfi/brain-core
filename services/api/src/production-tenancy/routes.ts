import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import {
  brainError,
  hashToken,
  isValidScope,
  newSecretToken,
  newTenantId,
  newTokenId,
  newUserId,
  requireScope,
  scopesForMemberRole,
  withTenantScope,
  type AuditEmitter,
  type JwtSigner,
  type RevocationStore,
  type Scope,
  type TenantScopedClient,
} from "@brain/shared";
import { insertBootstrapAdminMember } from "../onboarding/bootstrap-member.js";
import {
  ensureActiveDefaultPolicy,
  ensureBffServiceAgent,
  findActiveProductionAgentToken,
  insertProductionAgentToken,
  revokeProductionAgentTokens,
  SERVICE_TOKEN_SCOPES,
  type AgentTokenSeed,
} from "../onboarding/service-token.js";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_DAYS = 30;
// AUTH-PATHS-PLAN.md section 2: same TTL as onboarding/routes.ts's
// VERIFICATION_TTL_MS, reusing the same email_verifications table verbatim
// (no `purpose` column -- see that file's header for why a replay of an old
// signup-verification email against /set-password is not a real objection).
const SET_PASSWORD_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** A founder email that resolves to bootstrapPlaceholderEmail's undeliverable pattern. */
const BOOTSTRAP_PLACEHOLDER_EMAIL_SUFFIX = "@brain.invalid";
/**
 * Narrowest scope set (F1): what a session token falls back to when the
 * caller's actual role scopes cannot be determined -- e.g. a stored refresh
 * token from before `scopes` was recorded. Failing closed to `viewer` rather
 * than `admin` matters: a member who was never granted more than read access
 * must never gain it back through a refresh.
 */
const FAIL_CLOSED_SESSION_SCOPES: readonly Scope[] = scopesForMemberRole("viewer");
const PLATFORM_IDENTITY_LINK_UNIQUE_INDEX =
  "idx_member_identity_links_platform_external_ref_unique";

export interface ProductionTenancyRoutesDeps {
  pool: Pool;
  resolverPool: Pool;
  audit: AuditEmitter;
  signer: JwtSigner;
  revocation?: RevocationStore;
  platformSecret?: string;
  smartAccount?: string;
  /**
   * AUTH-PATHS-PLAN.md section 2 hard prerequisite: without this, every
   * founder created by POST /tenants has a users row with no password and no
   * way to ever authenticate at auth.brain.fi. Optional (not a boot fence)
   * because this route has no feature flag to gate it off the way self-serve
   * signup does -- a missing delivery dependency must not fail tenant
   * creation, only leave the invite unsent (recorded in the response and the
   * tenant.created audit event, never silent).
   */
  deliverSetPasswordEmail?: (input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly email: string;
    readonly token: string;
    readonly expiresAt: Date;
  }) => Promise<void>;
  demoSeeder?: ProductionTenantDemoSeeder;
}

export interface ProductionTenantDemoSeed {
  tenantId: string;
  actor: string;
  vendors?: Record<string, string>;
  customers?: Record<string, string>;
  accounts?: Record<string, string | null>;
  apInvoices?: Record<string, string>;
  arInvoices?: Record<string, string>;
  sources?: Record<string, string>;
  proposals?: Record<string, string>;
  policyId?: string;
  agentId?: string;
}

export type ProductionTenantDemoSeeder = (input: {
  tenantId: string;
  actor: string;
  companyName: string | null;
  founderEmail: string;
}) => Promise<ProductionTenantDemoSeed>;

interface MemberRow {
  tenant_id: string;
  id: string;
  email: string;
  display_name: string;
  role: "admin" | "approver" | "viewer";
  status: "invited" | "active" | "deactivated";
  active: boolean;
  approval_domains: string[];
  per_item_limit_cents: string | number | bigint;
  requires_second_approver_above_cents: string | number | bigint | null;
}

interface RefreshRow {
  tenant_id: string;
  member_id: string;
  token_hash: string;
  family_id: string;
  expires_at: Date | string;
  rotated_at: Date | string | null;
  revoked_at: Date | string | null;
  scopes?: Scope[];
}

interface InviteRow {
  tenant_id: string;
  member_id: string;
  token_hash: string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  revoked_at: Date | string | null;
  member_status: "invited" | "active" | "deactivated";
  email: string;
  display_name: string;
  role: "admin" | "approver" | "viewer";
  approval_domains: string[];
  per_item_limit_cents: string | number | bigint;
  requires_second_approver_above_cents: string | number | bigint | null;
}

interface TenantKindRow {
  kind: "production" | "demo";
}

export async function registerProductionTenancyRoutes(
  app: FastifyInstance,
  deps: ProductionTenancyRoutesDeps,
): Promise<void> {
  // Handles POST "/tenants" and POST "/orgs/:orgId/tenants"; keep the BFF agent
  // and token creation before the 201 response.
  const createProductionTenant = async (
    request: FastifyRequest<{
      Params: { orgId?: string };
      Body?: {
        company_name?: unknown;
        founder?: { email?: unknown; display_name?: unknown };
        founder_external_ref?: unknown;
        demo_seed?: unknown;
      };
    }>,
    reply: FastifyReply,
  ) => {
    assertPlatformCredential(request, deps.platformSecret, "tenant:create");
    if (request.headers["x-demo-provision-auth"] !== undefined) {
      reply.status(401);
      return { reason: "platform_service_credential_required" };
    }

    const body = request.body;
    const demoSeedRequested = parseDemoSeedRequested(body?.demo_seed);
    const demoSeeder = demoSeedRequested ? deps.demoSeeder : undefined;
    if (demoSeedRequested && demoSeeder === undefined) {
      throw brainError("dependency_unavailable", "production demo seeder is not configured", {
        details: { required_scope: "tenant:create" },
      });
    }
    const founderEmail = requireString(body?.founder?.email, "founder.email").toLowerCase();
    const founderDisplayName =
      typeof body?.founder?.display_name === "string" && body.founder.display_name.length > 0
        ? body.founder.display_name
        : founderEmail;
    const companyName = typeof body?.company_name === "string" ? body.company_name : null;
    const externalRef = requireString(body?.founder_external_ref, "founder_external_ref");
    const linkedMember = await findMemberByPlatformExternalRef(deps.resolverPool, externalRef);
    if (linkedMember !== null) throw platformIdentityAlreadyLinked(linkedMember.tenant_id);
    const tenantId = newTenantId();
    const memberId = newUserId();
    // The bootstrap member insertBootstrapAdminMember creates below is always
    // role=admin, so the founder's own session is minted with admin scopes.
    const sessionSeed = newSessionSeed(tenantId, memberId, undefined, scopesForMemberRole("admin"));
    const smartAccount =
      deps.smartAccount ?? process.env["BRAIN_ONCHAIN_SMART_ACCOUNT"] ?? zeroAddress();

    // AUTH-PATHS-PLAN.md section 2 hard prerequisite: the founder's users row
    // is created with no password (below); without a set-password invite, that
    // founder is born unable to ever authenticate at auth.brain.fi. Minted and
    // inserted in the same transaction as the tenant, mirroring
    // onboarding/provision.ts's email_verifications insert.
    const setPasswordToken = newSecretToken();
    const setPasswordTokenExpiresAt = new Date(Date.now() + SET_PASSWORD_TOKEN_TTL_MS);

    let agentResult: { agentId: string; agentCreated: boolean; agentToken: AgentTokenSeed };
    try {
      agentResult = await withTenantScope(deps.pool, tenantId, async (client) => {
        await client.query(
          `INSERT INTO tenants (id, kind, sandbox, created_via, audit_anchor_mode)
             VALUES ($1, 'production', FALSE, 'admin', $2)`,
          [tenantId, demoSeedRequested ? "db_only" : "onchain"],
        );
        await client.query(
          `INSERT INTO users (id, tenant_id, email, role)
             VALUES ($1, $2, $3, 'owner')
             ON CONFLICT DO NOTHING`,
          [memberId, tenantId, founderEmail],
        );
        await client.query(
          `INSERT INTO email_verifications (token_hash, user_id, tenant_id, expires_at)
             VALUES ($1, $2, $3, $4)`,
          [hashToken(setPasswordToken), memberId, tenantId, setPasswordTokenExpiresAt],
        );
        await insertBootstrapAdminMember(client, {
          tenantId,
          memberId,
          email: founderEmail,
          displayName: founderDisplayName,
        });
        await insertPlatformIdentityLink(client, tenantId, memberId, externalRef);
        await ensureActiveDefaultPolicy(client, tenantId, memberId);
        await insertRefreshToken(client, sessionSeed);
        const agent = await ensureBffServiceAgent(client, tenantId, smartAccount);
        const agentToken = await insertProductionAgentToken(client, tenantId, agent.agentId);
        return { agentId: agent.agentId, agentCreated: agent.created, agentToken };
      });
    } catch (err) {
      if (!isPlatformIdentityLinkConflict(err)) throw err;
      const linkedAfterConflict = await findMemberByPlatformExternalRef(
        deps.resolverPool,
        externalRef,
      );
      if (linkedAfterConflict === null) throw err;
      throw platformIdentityAlreadyLinked(linkedAfterConflict.tenant_id);
    }

    const member = await findMemberInTenant(deps.pool, tenantId, memberId);
    if (member === null) throw brainError("internal_server_error", "bootstrap member missing");
    const token = await signMemberToken(deps.signer, sessionSeed);
    const agentToken = await signAgentToken(deps.signer, agentResult.agentToken);

    // Sending happens after commit, same as onboarding/routes.ts: a failure
    // here must never look like tenant creation itself failed (the tenant,
    // member, and agent already exist). bootstrapPlaceholderEmail's
    // "@brain.invalid" pattern is guaranteed undeliverable -- skip the send
    // attempt for it rather than calling an ESP that will only bounce. Either
    // way the outcome is recorded on tenant.created below, never silent.
    let founderInviteEmail: "sent" | "not_sent" | "undeliverable_address" = "not_sent";
    if (founderEmail.endsWith(BOOTSTRAP_PLACEHOLDER_EMAIL_SUFFIX)) {
      founderInviteEmail = "undeliverable_address";
    } else if (deps.deliverSetPasswordEmail !== undefined) {
      try {
        await deps.deliverSetPasswordEmail({
          tenantId,
          userId: memberId,
          email: founderEmail,
          token: setPasswordToken,
          expiresAt: setPasswordTokenExpiresAt,
        });
        founderInviteEmail = "sent";
      } catch (err) {
        request.log.warn(
          { err },
          "founder set-password invite email failed to send; tenant creation still succeeded",
        );
      }
    }

    await deps.audit.emit({
      tenantId,
      layer: "execution",
      actor: memberId,
      action: "tenant.created",
      inputs: { company_name: typeof body?.company_name === "string" ? body.company_name : null },
      outputs: {
        tenant_id: tenantId,
        member_id: memberId,
        agent_id: agentResult.agentId,
        founder_invite_email: founderInviteEmail,
      },
    });
    await deps.audit.emit({
      tenantId,
      layer: "execution",
      actor: memberId,
      action: "member.changed",
      inputs: { mutation: "bootstrap", before: null },
      outputs: { after: serializeMember(member) },
    });
    await deps.audit.emit({
      tenantId,
      layer: "agent",
      actor: agentResult.agentId,
      action: "auth.production_agent_token.minted",
      inputs: { tenant_created: true, agent_created: agentResult.agentCreated, rotated: false },
      outputs: {
        tenant_id: tenantId,
        agent_id: agentResult.agentId,
        token_id: agentResult.agentToken.tokenId,
      },
    });

    let demoSeed: ProductionTenantDemoSeed | null = null;
    if (demoSeeder !== undefined) {
      demoSeed = await demoSeeder({
        tenantId,
        actor: memberId,
        companyName,
        founderEmail,
      });
      await deps.audit.emit({
        tenantId,
        layer: "execution",
        actor: memberId,
        action: "tenant.demo_seeded",
        inputs: { company_name: companyName },
        outputs: {
          tenant_id: tenantId,
          sources: Object.keys(demoSeed.sources ?? {}).length,
          proposals: Object.keys(demoSeed.proposals ?? {}).length,
          accounts: Object.keys(demoSeed.accounts ?? {}).length,
          ap_invoices: Object.keys(demoSeed.apInvoices ?? {}).length,
          ar_invoices: Object.keys(demoSeed.arInvoices ?? {}).length,
          policy_id: demoSeed.policyId ?? null,
          agent_id: demoSeed.agentId ?? null,
        },
      });
    }

    reply.status(201);
    return {
      tenant_id: tenantId,
      ...(request.params.orgId !== undefined ? { org_id: request.params.orgId } : {}),
      member: serializeMember(member),
      session: {
        token,
        refresh_token: sessionSeed.refreshToken,
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
      },
      agent: serializeAgentToken(agentResult.agentId, agentToken, agentResult.agentToken),
      founder_invite_email: founderInviteEmail,
      ...(demoSeed !== null ? { demo_seed: serializeDemoSeed(demoSeed) } : {}),
    };
  };

  app.post(
    "/tenants",
    { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: "1 minute" } } },
    createProductionTenant,
  );

  app.post(
    "/orgs/:orgId/tenants",
    { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: "1 minute" } } },
    createProductionTenant,
  );

  app.post(
    "/tenants/:tenantId/agent-token",
    { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      assertPlatformCredential(request, deps.platformSecret, "tenant:agent-mint");
      const { tenantId } = request.params as { tenantId: string };
      const body = request.body as { rotate?: unknown } | undefined;
      const rotate = body?.rotate === true;
      const smartAccount =
        deps.smartAccount ?? process.env["BRAIN_ONCHAIN_SMART_ACCOUNT"] ?? zeroAddress();

      let revoked: AgentTokenSeed[] = [];
      const result = await withTenantScope(deps.pool, tenantId, async (client) => {
        const tenant = await findTenantKind(client, tenantId);
        if (tenant === null) {
          throw brainError("tenant_not_found", "tenant does not exist", { statusOverride: 404 });
        }
        if (tenant.kind !== "production") {
          throw brainError("auth_scope_insufficient", "tenant is not production", {
            statusOverride: 403,
            details: { reason: "production_agent_required" },
          });
        }

        const agent = await ensureBffServiceAgent(client, tenantId, smartAccount);
        if (rotate) {
          revoked = await revokeProductionAgentTokens(client, tenantId, agent.agentId);
        } else {
          const existing = await findActiveProductionAgentToken(client, tenantId, agent.agentId);
          if (existing !== null) {
            return {
              agentId: agent.agentId,
              agentCreated: agent.created,
              token: existing,
              tokenCreated: false,
            };
          }
        }

        const token = await insertProductionAgentToken(client, tenantId, agent.agentId);
        return {
          agentId: agent.agentId,
          agentCreated: agent.created,
          token,
          tokenCreated: true,
        };
      });

      const revocation = deps.revocation;
      if (rotate && revocation !== undefined) {
        await Promise.all(
          revoked.map((token) => revocation.revoke(token.tokenId, token.expiresAt)),
        );
      }

      const token = await signAgentToken(deps.signer, result.token);
      await deps.audit.emit({
        tenantId,
        layer: "agent",
        actor: result.agentId,
        action: "auth.production_agent_token.minted",
        inputs: {
          rotated: rotate,
          agent_created: result.agentCreated,
          token_created: result.tokenCreated,
        },
        outputs: {
          tenant_id: tenantId,
          agent_id: result.agentId,
          token_id: result.token.tokenId,
          revoked_token_ids: revoked.map((row) => row.tokenId),
        },
      });

      reply.status(result.tokenCreated ? 201 : 200);
      return serializeAgentToken(result.agentId, token, result.token);
    },
  );

  app.post(
    "/sessions",
    { config: { skipAuth: true, rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      assertPlatformCredential(request, deps.platformSecret, "session:exchange");
      const body = request.body as { external_ref?: unknown; scopes?: unknown } | undefined;
      const externalRef = requireString(body?.external_ref, "external_ref");
      const member = await findMemberByPlatformExternalRef(deps.resolverPool, externalRef);
      if (member === null || member.status !== "active") {
        reply.status(403);
        return { reason: "session_identity_unlinked" };
      }
      const scopes = resolveRequestedScopes(body?.scopes, scopesForMemberRole(member.role));
      const sessionSeed = newSessionSeed(member.tenant_id, member.id, undefined, scopes);
      await withTenantScope(deps.pool, member.tenant_id, (client) =>
        insertRefreshToken(client, sessionSeed),
      );
      const token = await signMemberToken(deps.signer, sessionSeed);
      return {
        token,
        refresh_token: sessionSeed.refreshToken,
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scopes: sessionSeed.scopes,
        member: serializeMember(member),
      };
    },
  );

  app.post(
    "/sessions/refresh",
    { config: { skipAuth: true, rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      const body = request.body as { refresh_token?: unknown; scopes?: unknown } | undefined;
      const refreshToken = requireString(body?.refresh_token, "refresh_token");
      const refresh = await findRefreshToken(deps.resolverPool, hashToken(refreshToken));
      if (refresh === null || refresh.revoked_at !== null || isPast(refresh.expires_at)) {
        throw brainError("auth_token_invalid", "refresh token invalid");
      }
      if (refresh.rotated_at !== null) {
        await withTenantScope(deps.pool, refresh.tenant_id, (client) =>
          revokeRefreshFamily(client, refresh.family_id),
        );
        throw brainError("auth_token_invalid", "refresh token reuse detected");
      }

      // F3 backstop: re-check the live members row on every refresh rather
      // than trusting the refresh-token row alone. This is what catches a
      // deactivation whose session-revocation write was somehow missed (a
      // bug, a crash mid-transaction elsewhere) -- refresh is the one place
      // every long-lived session must pass through, so failing closed here
      // bounds the exposure to at most one access-token TTL even if the
      // primary revocation path failed. It also re-derives the scope
      // ceiling from the member's CURRENT role: a stored refresh-token
      // `scopes` value can otherwise keep re-minting a since-demoted
      // member's old, wider scopes for the rest of the 30-day refresh
      // window.
      const member = await findMemberInTenant(deps.pool, refresh.tenant_id, refresh.member_id);
      if (member === null || member.status !== "active" || !member.active) {
        await withTenantScope(deps.pool, refresh.tenant_id, (client) =>
          revokeRefreshFamily(client, refresh.family_id),
        );
        throw brainError("auth_token_invalid", "refresh token invalid");
      }
      const currentEntitlements = scopesForMemberRole(member.role);
      const storedScopes = normalizeStoredScopes(refresh.scopes).filter((scope) =>
        currentEntitlements.includes(scope),
      );
      const scopes = resolveRequestedScopes(body?.scopes, storedScopes);
      const sessionSeed = newSessionSeed(
        refresh.tenant_id,
        refresh.member_id,
        refresh.family_id,
        scopes,
      );
      await withTenantScope(deps.pool, refresh.tenant_id, async (client) => {
        await client.query(
          `UPDATE session_refresh_tokens
              SET rotated_at = now()
            WHERE token_hash = $1 AND rotated_at IS NULL AND revoked_at IS NULL`,
          [refresh.token_hash],
        );
        await insertRefreshToken(client, sessionSeed);
      });
      const token = await signMemberToken(deps.signer, sessionSeed);
      return {
        token,
        refresh_token: sessionSeed.refreshToken,
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scopes: sessionSeed.scopes,
      };
    },
  );

  app.delete("/sessions", async (request) => {
    const principal = request.principal;
    if (principal === undefined) throw brainError("auth_token_missing", "principal required");
    if (principal.type !== "user") {
      throw brainError("payment_intent_approval_invalid", "actor_unresolved", {
        statusOverride: 403,
        details: { reason: "actor_unresolved" },
      });
    }
    await withTenantScope(deps.pool, principal.tenantId, (client) =>
      revokeMemberRefreshTokens(client, principal.id),
    );
    return { revoked: true };
  });

  app.post(
    "/invites/pending",
    { config: { skipAuth: true, rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      assertPlatformCredential(request, deps.platformSecret, "invite:consume");
      const body = request.body as { email?: unknown } | undefined;
      const email = normalizeEmail(requireString(body?.email, "email"));
      return { pending: await hasPendingInviteForEmail(deps.resolverPool, email) };
    },
  );

  app.post(
    "/invites/consume",
    { config: { skipAuth: true, rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      assertPlatformCredential(request, deps.platformSecret, "invite:consume");
      const body = request.body as
        | { invite_token?: unknown; external_ref?: unknown; display_name?: unknown }
        | undefined;
      const inviteToken = requireString(body?.invite_token, "invite_token");
      const externalRef = requireString(body?.external_ref, "external_ref");
      const displayName =
        typeof body?.display_name === "string" && body.display_name.length > 0
          ? body.display_name
          : undefined;
      const invite = await findInvite(deps.resolverPool, hashToken(inviteToken));
      if (invite === null) {
        reply.status(403);
        return { reason: "invite_invalid" };
      }
      const blockedReason = inviteBlockedReason(invite);
      if (blockedReason !== null) {
        reply.status(403);
        return { reason: blockedReason };
      }

      const sessionSeed = newSessionSeed(
        invite.tenant_id,
        invite.member_id,
        undefined,
        scopesForMemberRole(invite.role),
      );
      const member = await withTenantScope(deps.pool, invite.tenant_id, async (client) => {
        const locked = await lockInvite(client, invite.token_hash);
        if (locked === null) throw brainError("internal_server_error", "invite disappeared");
        const lockedReason = inviteBlockedReason(locked);
        if (lockedReason !== null) {
          throw brainError(lockedReason, lockedReason, {
            statusOverride: 403,
            details: { reason: lockedReason },
          });
        }
        // AUTH-PATHS-PLAN.md section 1: users is the authentication principal,
        // members is the authority, joined by (tenant_id, id) equality. Invite
        // consume today only ever touches `members` -- an invited colleague has
        // no `users` row and so no way to ever authenticate at auth.brain.fi's
        // password login. password_hash stays NULL (keeping it out of the
        // users_login_email_unique partial index) until the member separately
        // runs /forgot-password. No migration: users already has this shape
        // (services/execution/migrations/0021_users_auth_columns.sql).
        //
        // ON CONFLICT (id) DO NOTHING, not a bare ON CONFLICT DO NOTHING: the
        // bare form also swallows a `users_tenant_id_email_key` violation (a
        // different email already claimed this (tenant_id, id) pair's row) as
        // if it were the intended "row already exists" idempotency case. No
        // reachable path to that state today (each invite mints a fresh
        // member_id), but the id-only target is free and precise.
        await client.query(
          `INSERT INTO users (id, tenant_id, email, role)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (id) DO NOTHING`,
          [invite.member_id, invite.tenant_id, invite.email, invite.role],
        );
        await insertPlatformIdentityLink(client, invite.tenant_id, invite.member_id, externalRef);
        const updated = await activateInvitedMember(client, invite.member_id, displayName);
        await client.query(
          `UPDATE member_invites
              SET consumed_at = now()
            WHERE token_hash = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
          [invite.token_hash],
        );
        await insertRefreshToken(client, sessionSeed);
        return updated;
      });
      const token = await signMemberToken(deps.signer, sessionSeed);
      await deps.audit.emit({
        tenantId: member.tenant_id,
        layer: "execution",
        actor: member.id,
        action: "invite.consumed",
        inputs: { member_id: member.id },
        outputs: { status: member.status },
      });
      return {
        tenant_id: member.tenant_id,
        member: serializeMember(member),
        session: {
          token,
          refresh_token: sessionSeed.refreshToken,
          expires_in: ACCESS_TOKEN_TTL_SECONDS,
        },
      };
    },
  );
}

/**
 * Verifies either a tenant-scoped bearer principal (with the required scope)
 * or the cross-tenant platform-service shared secret.
 *
 * Returns the tenant id the caller is bound to, or `undefined` when the
 * genuine platform-service credential was used (that credential is
 * legitimately cross-tenant, so it names no single tenant here -- callers
 * take the tenant id from elsewhere, e.g. a path param or request body).
 * A bearer principal is never cross-tenant: its scopes may permit an action,
 * but the tenant it can act on is always its own, never one named by an
 * untrusted query/body field.
 */
export function assertPlatformCredential(
  request: FastifyRequest,
  secret: string | undefined,
  scope: Scope,
): string | undefined {
  if (request.principal !== undefined) {
    requireScope(request.principal.scopes, scope);
    return request.principal.tenantId;
  }
  if (secret === undefined || secret.length === 0) {
    throw brainError("dependency_unavailable", "BRAIN_PLATFORM_SERVICE_SECRET is not configured", {
      details: { required_scope: scope },
    });
  }
  const headerRaw = request.headers["x-platform-service-auth"];
  const provided = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
  const expectedBuf = Buffer.from(secret, "utf8");
  const providedBuf = Buffer.from(provided ?? "", "utf8");
  const ok = providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
  if (!ok) {
    throw brainError("auth_token_invalid", "platform service credential invalid", {
      details: { required_scope: scope },
    });
  }
  return undefined;
}

function parseDemoSeedRequested(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (typeof raw === "boolean") return raw;
  throw brainError("request_body_invalid", "demo_seed must be a boolean");
}

function serializeDemoSeed(seed: ProductionTenantDemoSeed): Record<string, unknown> {
  return {
    seeded: true,
    sources: seed.sources ?? {},
    proposals: seed.proposals ?? {},
    accounts: seed.accounts ?? {},
    ap_invoices: seed.apInvoices ?? {},
    ar_invoices: seed.arInvoices ?? {},
    policy_id: seed.policyId ?? null,
    agent_id: seed.agentId ?? null,
  };
}

interface SessionSeed {
  tenantId: string;
  memberId: string;
  tokenId: string;
  familyId: string;
  refreshToken: string;
  refreshTokenHash: string;
  expiresAt: number;
  scopes: readonly Scope[];
}

function newSessionSeed(
  tenantId: string,
  memberId: string,
  familyId: string | undefined,
  // No default: every caller must derive scopes from the member's role
  // (F1) rather than falling back to a flat, always-admin-equivalent set.
  scopes: readonly Scope[],
): SessionSeed {
  const refreshToken = newSecretToken();
  return {
    tenantId,
    memberId,
    tokenId: newTokenId(),
    familyId: familyId ?? newTokenId(),
    refreshToken,
    refreshTokenHash: hashToken(refreshToken),
    expiresAt: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
    scopes,
  };
}

async function signMemberToken(signer: JwtSigner, seed: SessionSeed): Promise<string> {
  return signer.sign({
    id: seed.memberId,
    type: "user",
    tenantId: seed.tenantId,
    tokenId: seed.tokenId,
    expiresAt: seed.expiresAt,
    scopes: [...seed.scopes],
  });
}

async function signAgentToken(signer: JwtSigner, seed: AgentTokenSeed): Promise<string> {
  return signer.sign({
    id: seed.agentId,
    type: "agent",
    tenantId: seed.tenantId,
    tokenId: seed.tokenId,
    expiresAt: seed.expiresAt,
    scopes: SERVICE_TOKEN_SCOPES,
  });
}

async function insertRefreshToken(client: TenantScopedClient, seed: SessionSeed): Promise<void> {
  await client.query(
    `INSERT INTO session_refresh_tokens
       (tenant_id, member_id, token_hash, family_id, token_id, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, now() + ($6::text || ' days')::interval, $7::text[])`,
    [
      seed.tenantId,
      seed.memberId,
      seed.refreshTokenHash,
      seed.familyId,
      seed.tokenId,
      REFRESH_TOKEN_TTL_DAYS,
      [...seed.scopes],
    ],
  );
}

async function insertPlatformIdentityLink(
  client: TenantScopedClient,
  tenantId: string,
  memberId: string,
  externalRef: string,
): Promise<void> {
  await client.query(
    `INSERT INTO member_identity_links (tenant_id, member_id, surface, external_ref)
     VALUES ($1, $2, 'platform', $3)
     ON CONFLICT (tenant_id, surface, external_ref)
     DO UPDATE SET member_id = EXCLUDED.member_id, linked_at = now()`,
    [tenantId, memberId, externalRef],
  );
}

function platformIdentityAlreadyLinked(tenantId: string) {
  return brainError(
    "tenant_identity_already_linked",
    "platform identity is already linked to a tenant",
    { details: { tenant_id: tenantId } },
  );
}

function isPlatformIdentityLinkConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const dbError = err as { code?: unknown; constraint?: unknown };
  return dbError.code === "23505" && dbError.constraint === PLATFORM_IDENTITY_LINK_UNIQUE_INDEX;
}

async function findTenantKind(
  client: TenantScopedClient,
  tenantId: string,
): Promise<TenantKindRow | null> {
  const { rows } = await client.query<TenantKindRow>(
    `SELECT kind FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId],
  );
  return rows[0] ?? null;
}

async function findMemberInTenant(
  pool: Pool,
  tenantId: string,
  memberId: string,
): Promise<MemberRow | null> {
  return withTenantScope(pool, tenantId, async (client) => {
    const { rows } = await client.query<MemberRow>(
      `SELECT tenant_id, id, email, display_name, role, status, active, approval_domains,
              per_item_limit_cents, requires_second_approver_above_cents
         FROM members
        WHERE id = $1
        LIMIT 1`,
      [memberId],
    );
    return rows[0] ?? null;
  });
}

async function findMemberByPlatformExternalRef(pool: Pool, externalRef: string) {
  const { rows } = await pool.query<MemberRow>(
    `SELECT m.tenant_id, m.id, m.email, m.display_name, m.role, m.status, m.active,
            m.approval_domains, m.per_item_limit_cents,
            m.requires_second_approver_above_cents
       FROM member_identity_links l
       JOIN members m
         ON m.tenant_id = l.tenant_id
        AND m.id = l.member_id
      WHERE l.surface = 'platform'
        AND l.external_ref = $1
      LIMIT 1`,
    [externalRef],
  );
  return rows[0] ?? null;
}

async function findRefreshToken(pool: Pool, tokenHash: string): Promise<RefreshRow | null> {
  const { rows } = await pool.query<RefreshRow>(
    `SELECT tenant_id, member_id, token_hash, family_id, expires_at, rotated_at, revoked_at, scopes
       FROM session_refresh_tokens
      WHERE token_hash = $1
      LIMIT 1`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

async function revokeRefreshFamily(client: TenantScopedClient, familyId: string): Promise<void> {
  await client.query(
    `UPDATE session_refresh_tokens
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE family_id = $1`,
    [familyId],
  );
}

async function revokeMemberRefreshTokens(
  client: TenantScopedClient,
  memberId: string,
): Promise<void> {
  await client.query(
    `UPDATE session_refresh_tokens
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE member_id = $1
        AND revoked_at IS NULL`,
    [memberId],
  );
}

async function findInvite(pool: Pool, tokenHash: string): Promise<InviteRow | null> {
  const { rows } = await pool.query<InviteRow>(
    `SELECT i.tenant_id, i.member_id, i.token_hash, i.expires_at, i.consumed_at, i.revoked_at,
            m.status AS member_status, m.email, m.display_name, m.role, m.approval_domains,
            m.per_item_limit_cents, m.requires_second_approver_above_cents
       FROM member_invites i
       JOIN members m
         ON m.tenant_id = i.tenant_id
        AND m.id = i.member_id
      WHERE i.token_hash = $1
      LIMIT 1`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

async function hasPendingInviteForEmail(pool: Pool, email: string): Promise<boolean> {
  const { rows } = await pool.query<{ pending: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM member_invites i
         JOIN members m
           ON m.tenant_id = i.tenant_id
          AND m.id = i.member_id
        WHERE lower(btrim(m.email)) = $1
          AND m.status = 'invited'
          AND i.consumed_at IS NULL
          AND i.revoked_at IS NULL
          AND i.expires_at > now()
     ) AS pending`,
    [email],
  );
  return rows[0]?.pending === true;
}

async function lockInvite(
  client: TenantScopedClient,
  tokenHash: string,
): Promise<InviteRow | null> {
  const { rows } = await client.query<InviteRow>(
    `SELECT i.tenant_id, i.member_id, i.token_hash, i.expires_at, i.consumed_at, i.revoked_at,
            m.status AS member_status, m.email, m.display_name, m.role, m.approval_domains,
            m.per_item_limit_cents, m.requires_second_approver_above_cents
       FROM member_invites i
       JOIN members m
         ON m.tenant_id = i.tenant_id
        AND m.id = i.member_id
      WHERE i.token_hash = $1
      FOR UPDATE OF i, m
      LIMIT 1`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

function inviteBlockedReason(
  invite: Pick<InviteRow, "expires_at" | "consumed_at" | "revoked_at" | "member_status">,
): "invite_expired" | "invite_consumed" | "invite_revoked" | null {
  if (invite.consumed_at !== null) return "invite_consumed";
  if (invite.revoked_at !== null) return "invite_revoked";
  if (invite.member_status !== "invited") return "invite_revoked";
  if (isPast(invite.expires_at)) return "invite_expired";
  return null;
}

async function activateInvitedMember(
  client: TenantScopedClient,
  memberId: string,
  displayName: string | undefined,
): Promise<MemberRow> {
  const { rows } = await client.query<MemberRow>(
    `UPDATE members
        SET status = 'active',
            active = true,
            display_name = COALESCE($2, display_name),
            updated_at = now()
      WHERE id = $1
        AND status = 'invited'
      RETURNING tenant_id, id, email, display_name, role, status, active, approval_domains,
                per_item_limit_cents, requires_second_approver_above_cents`,
    [memberId, displayName ?? null],
  );
  const row = rows[0];
  if (row === undefined) throw brainError("invite_revoked", "invite_revoked");
  return row;
}

function serializeMember(member: MemberRow) {
  return {
    id: member.id,
    tenantId: member.tenant_id,
    email: member.email,
    displayName: member.display_name,
    role: member.role,
    status: member.status,
    active: member.status === "active" && member.active,
    approval: {
      domains: member.approval_domains,
      perItemLimit: Number(member.per_item_limit_cents),
      requiresSecondApproverAbove:
        member.requires_second_approver_above_cents === null
          ? null
          : Number(member.requires_second_approver_above_cents),
    },
  };
}

function serializeAgentToken(agentId: string, token: string, seed: AgentTokenSeed) {
  return {
    id: agentId,
    token,
    principal_type: "agent",
    subject: agentId,
    tenant_id: seed.tenantId,
    token_id: seed.tokenId,
    scopes: SERVICE_TOKEN_SCOPES,
    expires_in: Math.max(0, seed.expiresAt - Math.floor(Date.now() / 1000)),
    use: "propose-only agent workflows",
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw brainError("request_body_invalid", `${name} required`);
  }
  return value.trim();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function resolveRequestedScopes(raw: unknown, entitlements: readonly Scope[]): readonly Scope[] {
  if (raw === undefined) return [...entitlements];
  if (!Array.isArray(raw)) {
    throw brainError("request_body_invalid", "scopes must be an array of scope strings");
  }

  const requested: Scope[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !isValidScope(value)) {
      throw brainError("request_body_invalid", "scopes contains an unknown scope", {
        details: { scope: value },
      });
    }
    if (!requested.includes(value)) requested.push(value);
  }

  const held = new Set(entitlements);
  const unheld = requested.filter((scope) => !held.has(scope));
  if (unheld.length > 0) {
    throw brainError("auth_scope_insufficient", "requested scope is not held by principal", {
      statusOverride: 403,
      details: { requested: unheld, held: entitlements },
    });
  }
  return requested;
}

function normalizeStoredScopes(scopes: readonly Scope[] | undefined): readonly Scope[] {
  // F1: a NULL `session_refresh_tokens.scopes` value used to fall back to the
  // full admin-equivalent scope set, silently re-widening a session that was
  // deliberately narrowed (or minted before this column existed). Fail closed
  // to the narrowest role's scopes instead -- a refresh can only ever shrink
  // an under-specified session, never grow one.
  if (scopes === undefined) return FAIL_CLOSED_SESSION_SCOPES;
  return scopes.filter((scope): scope is Scope => isValidScope(scope));
}

function isPast(value: Date | string): boolean {
  return new Date(value).getTime() <= Date.now();
}

function zeroAddress(): string {
  return "0x0000000000000000000000000000000000000000";
}
