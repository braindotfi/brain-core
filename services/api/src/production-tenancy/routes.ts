import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import {
  brainError,
  newTenantId,
  newTokenId,
  newUserId,
  withTenantScope,
  type AuditEmitter,
  type JwtSigner,
  type RevocationStore,
  type Scope,
  type TenantScopedClient,
} from "@brain/shared";
import { insertBootstrapAdminMember } from "../onboarding/bootstrap-member.js";
import {
  ensureBffServiceAgent,
  findActiveProductionAgentToken,
  insertProductionAgentToken,
  revokeProductionAgentTokens,
  SERVICE_TOKEN_SCOPES,
  type AgentTokenSeed,
} from "../onboarding/service-token.js";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_DAYS = 30;
const MEMBER_SESSION_SCOPES = [
  "ledger:read",
  "ledger:write",
  "wiki:read",
  "raw:read",
  "policy:read",
  "execution:read",
  "execution:admin",
  "payment_intent:approve",
  "audit:read",
] as const satisfies readonly Scope[];

export interface ProductionTenancyRoutesDeps {
  pool: Pool;
  resolverPool: Pool;
  audit: AuditEmitter;
  signer: JwtSigner;
  revocation?: RevocationStore;
  platformSecret?: string;
  smartAccount?: string;
}

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
  app.post(
    "/tenants",
    { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      assertPlatformCredential(request, deps.platformSecret, "tenant:create");
      if (request.headers["x-demo-provision-auth"] !== undefined) {
        reply.status(401);
        return { reason: "platform_service_credential_required" };
      }

      const body = request.body as
        | {
            company_name?: unknown;
            founder?: { email?: unknown; display_name?: unknown };
            founder_external_ref?: unknown;
          }
        | undefined;
      const founderEmail = requireString(body?.founder?.email, "founder.email").toLowerCase();
      const founderDisplayName =
        typeof body?.founder?.display_name === "string" && body.founder.display_name.length > 0
          ? body.founder.display_name
          : founderEmail;
      const externalRef = requireString(body?.founder_external_ref, "founder_external_ref");
      const tenantId = newTenantId();
      const memberId = newUserId();
      const sessionSeed = newSessionSeed(tenantId, memberId);
      const smartAccount =
        deps.smartAccount ?? process.env["BRAIN_ONCHAIN_SMART_ACCOUNT"] ?? zeroAddress();

      const agentResult = await withTenantScope(deps.pool, tenantId, async (client) => {
        await client.query(
          `INSERT INTO tenants (id, kind, sandbox, created_via)
           VALUES ($1, 'production', FALSE, 'admin')`,
          [tenantId],
        );
        await client.query(
          `INSERT INTO users (id, tenant_id, email, role)
           VALUES ($1, $2, $3, 'owner')
           ON CONFLICT DO NOTHING`,
          [memberId, tenantId, founderEmail],
        );
        await insertBootstrapAdminMember(client, {
          tenantId,
          memberId,
          email: founderEmail,
          displayName: founderDisplayName,
        });
        await insertPlatformIdentityLink(client, tenantId, memberId, externalRef);
        await insertRefreshToken(client, sessionSeed);
        const agent = await ensureBffServiceAgent(client, tenantId, smartAccount);
        const agentToken = await insertProductionAgentToken(client, tenantId, agent.agentId);
        return { agentId: agent.agentId, agentCreated: agent.created, agentToken };
      });

      const member = await findMemberInTenant(deps.pool, tenantId, memberId);
      if (member === null) throw brainError("internal_server_error", "bootstrap member missing");
      const token = await signMemberToken(deps.signer, sessionSeed);
      const agentToken = await signAgentToken(deps.signer, agentResult.agentToken);
      await deps.audit.emit({
        tenantId,
        layer: "execution",
        actor: memberId,
        action: "tenant.created",
        inputs: { company_name: typeof body?.company_name === "string" ? body.company_name : null },
        outputs: { tenant_id: tenantId, member_id: memberId, agent_id: agentResult.agentId },
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

      reply.status(201);
      return {
        tenant_id: tenantId,
        member: serializeMember(member),
        session: {
          token,
          refresh_token: sessionSeed.refreshToken,
          expires_in: ACCESS_TOKEN_TTL_SECONDS,
        },
        agent: serializeAgentToken(agentResult.agentId, agentToken, agentResult.agentToken),
      };
    },
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
        await Promise.all(revoked.map((token) => revocation.revoke(token.tokenId, token.expiresAt)));
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
      const body = request.body as { external_ref?: unknown } | undefined;
      const externalRef = requireString(body?.external_ref, "external_ref");
      const member = await findMemberByPlatformExternalRef(deps.resolverPool, externalRef);
      if (member === null || member.status !== "active") {
        reply.status(403);
        return { reason: "session_identity_unlinked" };
      }
      const sessionSeed = newSessionSeed(member.tenant_id, member.id);
      await withTenantScope(deps.pool, member.tenant_id, (client) =>
        insertRefreshToken(client, sessionSeed),
      );
      const token = await signMemberToken(deps.signer, sessionSeed);
      return {
        token,
        refresh_token: sessionSeed.refreshToken,
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        member: serializeMember(member),
      };
    },
  );

  app.post(
    "/sessions/refresh",
    { config: { skipAuth: true, rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      const body = request.body as { refresh_token?: unknown } | undefined;
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

      const sessionSeed = newSessionSeed(refresh.tenant_id, refresh.member_id, refresh.family_id);
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

      const sessionSeed = newSessionSeed(invite.tenant_id, invite.member_id);
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

export function assertPlatformCredential(
  request: FastifyRequest,
  secret: string | undefined,
  scope: "tenant:create" | "tenant:agent-mint" | "session:exchange" | "invite:consume",
): void {
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
}

interface SessionSeed {
  tenantId: string;
  memberId: string;
  tokenId: string;
  familyId: string;
  refreshToken: string;
  refreshTokenHash: string;
  expiresAt: number;
}

function newSessionSeed(tenantId: string, memberId: string, familyId = newTokenId()): SessionSeed {
  const refreshToken = newSecretToken();
  return {
    tenantId,
    memberId,
    tokenId: newTokenId(),
    familyId,
    refreshToken,
    refreshTokenHash: hashToken(refreshToken),
    expiresAt: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
  };
}

async function signMemberToken(signer: JwtSigner, seed: SessionSeed): Promise<string> {
  return signer.sign({
    id: seed.memberId,
    type: "user",
    tenantId: seed.tenantId,
    tokenId: seed.tokenId,
    expiresAt: seed.expiresAt,
    scopes: MEMBER_SESSION_SCOPES,
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
       (tenant_id, member_id, token_hash, family_id, token_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6::text || ' days')::interval)`,
    [
      seed.tenantId,
      seed.memberId,
      seed.refreshTokenHash,
      seed.familyId,
      seed.tokenId,
      REFRESH_TOKEN_TTL_DAYS,
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
    `SELECT tenant_id, member_id, token_hash, family_id, expires_at, rotated_at, revoked_at
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

export function newSecretToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isPast(value: Date | string): boolean {
  return new Date(value).getTime() <= Date.now();
}

function zeroAddress(): string {
  return "0x0000000000000000000000000000000000000000";
}
