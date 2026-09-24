import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  hashPassword,
  hashToken,
  newSecretToken,
  newUserId,
  requireScope,
  withTenantScope,
  type AuditEmitter,
  type Scope,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";
import {
  countActiveAdmins,
  findMemberById,
  insertMember,
  listMembers,
  listUserAgentAuthority,
  replaceUserAgentAuthority,
  updateMember,
} from "../members/repository.js";
import type { MemberAuthority, MemberRole, UserAgentAuthority } from "../members/types.js";
import { assertRuleAgent } from "../rules/rules-engine.js";
import {
  NoneDirectoryProvider,
  TodoDirectoryProvider,
  type DirectoryProvider,
} from "./directory-provider.js";

const READ: Scope = "execution:read";
const ADMIN: Scope = "execution:admin";
const INVITE_TTL_HOURS = 72;

export interface TeamRoutesDeps {
  pool: Pool;
  audit: AuditEmitter;
  resolverPool?: Pool;
  directoryProvider?: DirectoryProvider;
  inviteBaseUrl?: string;
}

interface TeamBody {
  tenant_id?: unknown;
  email?: unknown;
  role?: unknown;
  agent_authority?: unknown;
}

interface TeamAcceptBody {
  invite_token?: unknown;
  display_name?: unknown;
  password?: unknown;
}

interface TeamPatchBody {
  role?: unknown;
  active?: unknown;
  agent_authority?: unknown;
}

type TeamAuthorityInput = Omit<UserAgentAuthority, "id" | "tenantId" | "userId">;

export async function registerTeamRoutes(
  app: FastifyInstance,
  deps: TeamRoutesDeps,
): Promise<void> {
  const directoryProvider = deps.directoryProvider ?? new NoneDirectoryProvider();

  app.get("/team", async (request: FastifyRequest<{ Querystring: { tenant_id?: string } }>) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, READ);
    rejectTenantOverride(request.query.tenant_id, ctx.tenantId);
    await requireAnyMember(deps.pool, ctx);
    const [members, authority] = await withTenantScope(deps.pool, ctx.tenantId, async (client) =>
      Promise.all([listMembers(client, { limit: 500 }), listUserAgentAuthority(client)]),
    );
    const lastActive = await withTenantScope(deps.pool, ctx.tenantId, (client) =>
      readLastActive(client),
    );
    return {
      users: members.map((member) =>
        serializeTeamUser(
          member,
          authority.filter((row) => row.userId === member.id),
          lastActive.get(member.id) ?? null,
        ),
      ),
      directory_provider: directoryProvider.kind,
    };
  });

  app.post("/team/invite", async (request: FastifyRequest<{ Body: TeamBody }>, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, ADMIN);
    await requireOwnerOrAdmin(deps.pool, ctx);
    const body = request.body ?? {};
    rejectTenantOverride(stringOrUndefined(body.tenant_id), ctx.tenantId);
    const email = requireString(body.email, "email").toLowerCase();
    const role = parseRole(body.role);
    const authority = parseAuthorityList(body.agent_authority);
    const token = newSecretToken();
    let savedAuthority: UserAgentAuthority[] = [];
    const member = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
      const created = await insertMember(client, {
        tenantId: ctx.tenantId,
        id: newUserId(),
        email,
        displayName: email,
        role,
        approvalDomains: ["ap", "ar", "treasury", "payroll", "reconciliation"],
        perItemLimitCents: 0n,
        requiresSecondApproverAboveCents: null,
        status: "invited",
      });
      savedAuthority = await replaceUserAgentAuthority(client, created.id, authority);
      await issuePendingInvite(client, {
        tenantId: ctx.tenantId,
        memberId: created.id,
        tokenHash: hashToken(token),
        email,
        role,
        issuedBy: ctx.actor,
        authority,
      });
      return created;
    });
    await deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "execution",
      actor: ctx.actor,
      action: "member.invited",
      inputs: { member_id: member.id },
      outputs: { role, authority_count: authority.length },
    });
    reply.status(201);
    return {
      user: serializeTeamUser(member, savedAuthority, null),
      invite_token_url: inviteUrl(deps.inviteBaseUrl, token),
      invite_token: token,
    };
  });

  app.post(
    "/team/accept",
    { config: { skipAuth: true } },
    async (request: FastifyRequest<{ Body: TeamAcceptBody }>) => {
      const body = request.body ?? {};
      const token = requireString(body.invite_token, "invite_token");
      const displayName = requireString(body.display_name, "display_name");
      const password =
        typeof body.password === "string" && body.password.length > 0 ? body.password : null;
      const invite = await findPendingInvite(deps.resolverPool ?? deps.pool, hashToken(token));
      if (invite === null || invite.revoked_at !== null || invite.accepted_at !== null) {
        throw brainError("team_invite_invalid", "invite is invalid", { statusOverride: 403 });
      }
      if (new Date(invite.expires_at).getTime() <= Date.now()) {
        throw brainError("team_invite_expired", "invite is expired", { statusOverride: 403 });
      }
      const passwordHash = password === null ? null : await hashPassword(password);
      const member = await withTenantScope(deps.pool, invite.tenant_id, async (client) => {
        if (passwordHash !== null) {
          await client.query(
            `INSERT INTO users (id, tenant_id, email, role, password_hash, status)
             VALUES ($1, $2, $3, $4, $5, 'active')
             ON CONFLICT (id) DO UPDATE
               SET email = EXCLUDED.email,
                   role = EXCLUDED.role,
                   password_hash = EXCLUDED.password_hash,
                   status = 'active'`,
            [invite.member_id, invite.tenant_id, invite.email, invite.role, passwordHash],
          );
        } else {
          await client.query(
            `INSERT INTO users (id, tenant_id, email, role, status)
             VALUES ($1, $2, $3, $4, 'active')
             ON CONFLICT (id) DO UPDATE
               SET email = EXCLUDED.email,
                   role = EXCLUDED.role,
                   status = 'active'`,
            [invite.member_id, invite.tenant_id, invite.email, invite.role],
          );
        }
        const updated = await updateMember(client, {
          id: invite.member_id,
          displayName,
          status: "active",
          active: true,
        });
        await client.query(
          `UPDATE pending_invites
              SET accepted_at = now()
            WHERE token_hash = $1
              AND accepted_at IS NULL
              AND revoked_at IS NULL`,
          [invite.token_hash],
        );
        return updated;
      });
      if (member === null) throw brainError("team_invite_invalid", "invite member missing");
      await deps.audit.emit({
        tenantId: member.tenantId,
        layer: "execution",
        actor: member.id,
        action: "user.joined",
        inputs: { member_id: member.id },
        outputs: { role: member.role },
      });
      return { user: serializeTeamUser(member, [], null) };
    },
  );

  app.patch(
    "/team/:user_id",
    async (request: FastifyRequest<{ Params: { user_id: string }; Body: TeamPatchBody }>) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, ADMIN);
      await requireOwnerOrAdmin(deps.pool, ctx);
      const before = await withTenantScope(deps.pool, ctx.tenantId, (client) =>
        findMemberById(client, request.params.user_id),
      );
      if (before === null) throw brainError("team_user_not_found", "team user not found");
      const body = request.body ?? {};
      if (wouldRemoveLastOwnerOrAdmin(before, body)) {
        await assertMoreThanOneOwnerOrAdmin(deps.pool, ctx);
      }
      const authority =
        body.agent_authority === undefined ? undefined : parseAuthorityList(body.agent_authority);
      const after = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
        const updated = await updateMember(client, {
          id: request.params.user_id,
          ...(body.role !== undefined ? { role: parseRole(body.role) } : {}),
          ...(body.active !== undefined ? { active: booleanField(body.active, "active") } : {}),
        });
        if (authority !== undefined) {
          await replaceUserAgentAuthority(client, request.params.user_id, authority);
        }
        return updated;
      });
      if (after === null) throw brainError("team_user_not_found", "team user not found");
      const finalAuthority = await withTenantScope(deps.pool, ctx.tenantId, (client) =>
        listUserAgentAuthority(client, after.id),
      );
      await deps.audit.emit({
        tenantId: ctx.tenantId,
        layer: "execution",
        actor: ctx.actor,
        action: "member.changed",
        inputs: { mutation: "team_updated", before: serializeTeamUser(before, [], null) },
        outputs: { after: serializeTeamUser(after, finalAuthority, null) },
      });
      return { user: serializeTeamUser(after, finalAuthority, null) };
    },
  );

  app.delete("/team/:user_id", async (request: FastifyRequest<{ Params: { user_id: string } }>) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, ADMIN);
    await requireOwnerOrAdmin(deps.pool, ctx);
    const before = await withTenantScope(deps.pool, ctx.tenantId, (client) =>
      findMemberById(client, request.params.user_id),
    );
    if (before === null) throw brainError("team_user_not_found", "team user not found");
    if ((before.role === "owner" || before.role === "admin") && before.active) {
      await assertMoreThanOneOwnerOrAdmin(deps.pool, ctx);
    }
    const after = await withTenantScope(deps.pool, ctx.tenantId, (client) =>
      updateMember(client, { id: request.params.user_id, status: "deactivated" }),
    );
    if (after === null) throw brainError("team_user_not_found", "team user not found");
    await deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "execution",
      actor: ctx.actor,
      action: "member.changed",
      inputs: { mutation: "team_deactivated", before: serializeTeamUser(before, [], null) },
      outputs: { after: serializeTeamUser(after, [], null) },
    });
    return { user: serializeTeamUser(after, [], null) };
  });
}

function assertCtx(request: FastifyRequest): ServiceCallContext {
  if (request.principal === undefined) throw brainError("auth_token_missing", "principal required");
  return {
    tenantId: request.principal.tenantId,
    actor: request.principal.id,
    requestId: request.id,
    principalType: request.principal.type,
    scopes: request.principal.scopes,
  };
}

async function requireAnyMember(pool: Pool, ctx: ServiceCallContext): Promise<MemberAuthority> {
  if (ctx.principalType !== "user") {
    throw brainError("payment_intent_approval_invalid", "actor_unresolved", {
      statusOverride: 403,
      details: { reason: "actor_unresolved" },
    });
  }
  const member = await withTenantScope(pool, ctx.tenantId, (client) =>
    findMemberById(client, ctx.actor),
  );
  if (member === null || !member.active) {
    throw brainError("payment_intent_approval_invalid", "actor_unresolved", {
      statusOverride: 403,
      details: { reason: "actor_unresolved" },
    });
  }
  return member;
}

async function requireOwnerOrAdmin(pool: Pool, ctx: ServiceCallContext): Promise<MemberAuthority> {
  const member = await requireAnyMember(pool, ctx);
  if (member.role !== "owner" && member.role !== "admin") {
    throw brainError("auth_scope_insufficient", "owner or admin member required");
  }
  return member;
}

function rejectTenantOverride(queryTenantId: string | undefined, ctxTenantId: string): void {
  if (queryTenantId !== undefined && queryTenantId !== ctxTenantId) {
    throw brainError("auth_tenant_mismatch", "tenant_id must match authenticated tenant");
  }
}

function serializeTeamUser(
  member: MemberAuthority,
  authority: readonly UserAgentAuthority[],
  lastActiveAt: string | null,
) {
  return {
    id: member.id,
    tenant_id: member.tenantId,
    email: member.email,
    display_name: member.displayName,
    role: member.role,
    active: member.active,
    status: member.status,
    last_active_at: lastActiveAt,
    agent_authority: authority.map((row) => ({
      id: row.id,
      agent: row.agent,
      can_approve: row.canApprove,
      can_edit: row.canEdit,
      can_reject: row.canReject,
      max_amount_cents: row.maxAmountCents === null ? null : Number(row.maxAmountCents),
      can_delegate: row.canDelegate,
    })),
  };
}

async function readLastActive(client: TenantScopedClient): Promise<Map<string, string | null>> {
  const { rows } = await client.query<{ member_id: string; last_active_at: Date | null }>(
    `SELECT member_id, max(created_at) AS last_active_at
       FROM session_refresh_tokens
      WHERE tenant_id = current_setting('app.tenant_id', true)
      GROUP BY member_id`,
  );
  return new Map(
    rows.map((row) => [
      row.member_id,
      row.last_active_at === null ? null : row.last_active_at.toISOString(),
    ]),
  );
}

async function issuePendingInvite(
  client: TenantScopedClient,
  input: {
    tenantId: string;
    memberId: string;
    tokenHash: string;
    email: string;
    role: MemberRole;
    issuedBy: string;
    authority: readonly TeamAuthorityInput[];
  },
): Promise<void> {
  await client.query(
    `UPDATE pending_invites
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE member_id = $1
        AND accepted_at IS NULL
        AND revoked_at IS NULL`,
    [input.memberId],
  );
  await client.query(
    `INSERT INTO pending_invites (
       tenant_id, member_id, token_hash, email, role, agent_authority,
       expires_at, issued_by
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, now() + ($7::text || ' hours')::interval, $8)`,
    [
      input.tenantId,
      input.memberId,
      input.tokenHash,
      input.email,
      input.role,
      JSON.stringify(
        input.authority.map((row) => ({
          ...row,
          maxAmountCents: row.maxAmountCents?.toString() ?? null,
        })),
      ),
      INVITE_TTL_HOURS,
      input.issuedBy,
    ],
  );
}

interface PendingInviteRow {
  tenant_id: string;
  member_id: string;
  token_hash: string;
  email: string;
  role: MemberRole;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

async function findPendingInvite(pool: Pool, tokenHash: string): Promise<PendingInviteRow | null> {
  const { rows } = await pool.query<PendingInviteRow>(
    `SELECT tenant_id, member_id, token_hash, email, role,
            expires_at::text, accepted_at::text, revoked_at::text
       FROM pending_invites
      WHERE token_hash = $1
      LIMIT 1`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

function parseAuthorityList(value: unknown): TeamAuthorityInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw brainError("request_body_invalid", "agent_authority must be an array");
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw brainError("request_body_invalid", "agent authority item must be an object");
    }
    const record = item as Record<string, unknown>;
    const agent = requireString(record["agent"], "agent");
    assertRuleAgent(agent);
    return {
      agent,
      canApprove: boolDefault(record["can_approve"], true),
      canEdit: boolDefault(record["can_edit"], true),
      canReject: boolDefault(record["can_reject"], true),
      maxAmountCents:
        record["max_amount_cents"] === undefined || record["max_amount_cents"] === null
          ? null
          : parseCents(record["max_amount_cents"]),
      canDelegate: boolDefault(record["can_delegate"], false),
    };
  });
}

function parseRole(value: unknown): MemberRole {
  if (
    value === "owner" ||
    value === "admin" ||
    value === "approver" ||
    value === "analyst" ||
    value === "viewer"
  ) {
    return value;
  }
  throw brainError("request_body_invalid", "invalid role");
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw brainError("request_body_invalid", `${name} required`);
  }
  return value;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boolDefault(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return booleanField(value, "boolean");
}

function booleanField(value: unknown, name: string): boolean {
  if (typeof value !== "boolean")
    throw brainError("request_body_invalid", `${name} must be boolean`);
  return value;
}

function parseCents(value: unknown): bigint {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  throw brainError("request_body_invalid", "invalid cents value");
}

function inviteUrl(baseUrl: string | undefined, token: string): string {
  const base = baseUrl ?? "https://app.brain.fi/team/accept";
  return `${base}?invite_token=${encodeURIComponent(token)}`;
}

function wouldRemoveLastOwnerOrAdmin(before: MemberAuthority, body: TeamPatchBody): boolean {
  return (
    (before.role === "owner" || before.role === "admin") &&
    before.active &&
    ((body.role !== undefined && body.role !== "owner" && body.role !== "admin") ||
      body.active === false)
  );
}

async function assertMoreThanOneOwnerOrAdmin(pool: Pool, ctx: ServiceCallContext): Promise<void> {
  const count = await withTenantScope(pool, ctx.tenantId, (client) => countActiveAdmins(client));
  if (count <= 1) {
    throw brainError("payment_intent_approval_invalid", "last_admin_protected", {
      statusOverride: 403,
      details: { reason: "last_admin_protected" },
    });
  }
}

export function directorySyncProvider(kind: string | undefined): DirectoryProvider {
  if (kind === undefined || kind === "none") return new NoneDirectoryProvider();
  if (kind === "okta" || kind === "google_workspace" || kind === "microsoft_entra") {
    return new TodoDirectoryProvider(kind);
  }
  throw brainError("request_body_invalid", "unknown directory provider");
}
