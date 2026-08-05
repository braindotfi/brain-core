import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  decodeKeysetCursor,
  encodeKeysetCursor,
  hashToken,
  newSecretToken,
  newUserId,
  requireScope,
  withTenantScope,
  type AuditEmitter,
  type RevocationStore,
  type Scope,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";
import {
  countActiveAdmins,
  deleteMemberIdentityLink,
  findMemberById,
  insertMember,
  insertMemberIdentityLink,
  listMembers,
  updateMember,
} from "./repository.js";
import type { ApprovalDomain, MemberAuthority, MemberIdentitySurface } from "./types.js";

const READ: Scope = "execution:read";
const ADMIN: Scope = "execution:admin";
const INVITE_TTL_HOURS = 72;
// F3: matches production-tenancy/routes.ts's ACCESS_TOKEN_TTL_SECONDS. Kept
// as a local constant (different service, same DB) rather than a shared
// import -- it only needs to be an upper bound on how long a just-revoked
// access token's jti stays in the revocation cache, and a session's actual
// access-token TTL never exceeds this value.
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface MemberRoutesDeps {
  pool: Pool;
  audit: AuditEmitter;
  /**
   * F3: deactivating a member used to update the `members` row and emit an
   * audit event but never touch `session_refresh_tokens` or the outstanding
   * access token's `jti`, so an offboarded member kept working access until
   * their 15-minute access token expired and could keep refreshing for up to
   * REFRESH_TOKEN_TTL_DAYS (30 days). Optional because a deployment without
   * Redis wiring still gets the `session_refresh_tokens` revocation (the
   * refresh backstop); only the immediate-jti cache is skipped.
   */
  revocation?: RevocationStore;
}

interface MemberBody {
  id?: string;
  email?: string;
  display_name?: string;
  role?: string;
  status?: string;
  active?: boolean;
  invite?: boolean;
  approval?: {
    domains?: string[];
    per_item_limit_cents?: number | string;
    requires_second_approver_above_cents?: number | string | null;
  };
}

interface IdentityLinkBody {
  surface?: string;
  external_ref?: string;
}

export async function registerMemberRoutes(
  app: FastifyInstance,
  deps: MemberRoutesDeps,
): Promise<void> {
  app.get(
    "/members",
    async (
      request: FastifyRequest<{
        Querystring: { role?: string; domain?: string; limit?: string; cursor?: string };
      }>,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, READ);
      await requireAnyMember(deps.pool, ctx);
      const limit = parseLimit(request.query.limit, 500);
      const cursor =
        request.query.cursor !== undefined ? decodeKeysetCursor(request.query.cursor) : undefined;
      const filters = {
        limit: limit + 1,
        ...(request.query.role !== undefined ? { role: request.query.role } : {}),
        ...(request.query.domain !== undefined ? { domain: request.query.domain } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      };
      const rows = await withTenantScope(deps.pool, ctx.tenantId, (c) => listMembers(c, filters));
      const visible = rows.slice(0, limit);
      const last = visible.at(-1);
      return {
        members: visible.map(serializeMember),
        next_cursor:
          rows.length > limit && last !== undefined
            ? encodeKeysetCursor({ sort: last.email, id: last.id })
            : null,
      };
    },
  );

  app.get("/members/:id", async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, READ);
    await requireAnyMember(deps.pool, ctx);
    const row = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
      findMemberById(c, request.params.id),
    );
    if (row === null) throw brainError("agent_not_found", "member not found");
    return serializeMember(row);
  });

  app.post("/members", async (request: FastifyRequest<{ Body: MemberBody }>, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, ADMIN);
    await requireAdmin(deps.pool, ctx);
    const b = request.body ?? {};
    const role = parseRole(b.role);
    const domains = parseDomains(b.approval?.domains);
    const before = null;
    const invite = b.invite === true;
    const inviteToken = invite ? newSecretToken() : undefined;
    const after = await withTenantScope(deps.pool, ctx.tenantId, async (c) => {
      const member = await insertMember(c, {
        tenantId: ctx.tenantId,
        id: b.id ?? newUserId(),
        email: requireString(b.email, "email"),
        displayName: b.display_name ?? requireString(b.email, "email"),
        role,
        approvalDomains: domains,
        perItemLimitCents: parseCents(b.approval?.per_item_limit_cents ?? "0"),
        requiresSecondApproverAboveCents: parseNullableCents(
          b.approval?.requires_second_approver_above_cents,
        ),
        status: invite ? "invited" : "active",
      });
      if (inviteToken !== undefined) {
        await issueInvite(c, {
          tenantId: ctx.tenantId,
          memberId: member.id,
          tokenHash: hashToken(inviteToken),
          issuedBy: ctx.actor,
        });
      }
      return member;
    });
    const audit = await emitMemberChanged(deps.audit, ctx, "created", before, after);
    if (inviteToken !== undefined) {
      await deps.audit.emit({
        tenantId: ctx.tenantId,
        layer: "execution",
        actor: ctx.actor,
        action: "member.invited",
        inputs: { member_id: after.id },
        outputs: { status: after.status },
      });
    }
    reply.status(201);
    return {
      member: serializeMember(after),
      audit_id: audit.id,
      ...(inviteToken !== undefined
        ? { invite_token: inviteToken, invite_expires_in_hours: INVITE_TTL_HOURS }
        : {}),
    };
  });

  app.patch(
    "/members/:id",
    async (request: FastifyRequest<{ Params: { id: string }; Body: MemberBody }>) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, ADMIN);
      await requireAdmin(deps.pool, ctx);
      const before = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
        findMemberById(c, request.params.id),
      );
      if (before === null) throw brainError("agent_not_found", "member not found");
      const body = request.body ?? {};
      if (wouldRemoveAdmin(before, body)) {
        await assertNotLastAdmin(deps.pool, ctx);
      }
      let revoked: RevokedSession[] = [];
      const after = await withTenantScope(deps.pool, ctx.tenantId, async (c) => {
        const updated = await updateMember(c, {
          id: request.params.id,
          ...(body.email !== undefined ? { email: requireString(body.email, "email") } : {}),
          ...(body.display_name !== undefined
            ? { displayName: requireString(body.display_name, "display_name") }
            : {}),
          ...(body.role !== undefined ? { role: parseRole(body.role) } : {}),
          ...(body.status !== undefined ? { status: parseStatus(body.status) } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          ...(body.approval?.domains !== undefined
            ? { approvalDomains: parseDomains(body.approval.domains) }
            : {}),
          ...(body.approval?.per_item_limit_cents !== undefined
            ? { perItemLimitCents: parseCents(body.approval.per_item_limit_cents) }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(
            body.approval ?? {},
            "requires_second_approver_above_cents",
          )
            ? {
                requiresSecondApproverAboveCents: parseNullableCents(
                  body.approval?.requires_second_approver_above_cents,
                ),
              }
            : {}),
        });
        // F3: revoke in the SAME transaction as the deactivation, not as a
        // separate best-effort follow-up call that could be skipped by a
        // crash or a bug in a caller.
        if (updated !== null && becomesInactive(updated)) {
          revoked = await revokeMemberSessions(c, updated.id);
        }
        return updated;
      });
      if (after === null) throw brainError("agent_not_found", "member not found");
      await revokeAccessTokenJtis(deps.revocation, revoked);
      const audit = await emitMemberChanged(deps.audit, ctx, "updated", before, after);
      return { member: serializeMember(after), audit_id: audit.id };
    },
  );

  app.delete("/members/:id", async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, ADMIN);
    await requireAdmin(deps.pool, ctx);
    const before = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
      findMemberById(c, request.params.id),
    );
    if (before === null) throw brainError("agent_not_found", "member not found");
    if (before.role === "admin" && before.active) await assertNotLastAdmin(deps.pool, ctx);
    let revoked: RevokedSession[] = [];
    const after = await withTenantScope(deps.pool, ctx.tenantId, async (c) => {
      const updated = await updateMember(c, { id: request.params.id, status: "deactivated" });
      // F3: same transaction as the deactivation -- see the PATCH handler
      // above for why this must not be a separate follow-up call.
      if (updated !== null) {
        revoked = await revokeMemberSessions(c, updated.id);
      }
      return updated;
    });
    if (after === null) throw brainError("agent_not_found", "member not found");
    await revokeAccessTokenJtis(deps.revocation, revoked);
    const audit = await emitMemberChanged(deps.audit, ctx, "deactivated", before, after);
    return { member: serializeMember(after), audit_id: audit.id };
  });

  app.post("/members/:id/invites", async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, ADMIN);
    await requireAdmin(deps.pool, ctx);
    const before = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
      findMemberById(c, request.params.id),
    );
    if (before === null) throw brainError("agent_not_found", "member not found");
    const inviteToken = newSecretToken();
    const expiresAt = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
      issueInvite(c, {
        tenantId: ctx.tenantId,
        memberId: before.id,
        tokenHash: hashToken(inviteToken),
        issuedBy: ctx.actor,
      }),
    );
    await deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "execution",
      actor: ctx.actor,
      action: "member.invited",
      inputs: { member_id: before.id, reissue: true },
      outputs: { expires_at: expiresAt },
    });
    return { invite_token: inviteToken, expires_at: expiresAt };
  });

  app.delete(
    "/members/:id/invites",
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, ADMIN);
      await requireAdmin(deps.pool, ctx);
      const before = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
        findMemberById(c, request.params.id),
      );
      if (before === null) throw brainError("agent_not_found", "member not found");
      await withTenantScope(deps.pool, ctx.tenantId, (c) => revokeOutstandingInvites(c, before.id));
      await deps.audit.emit({
        tenantId: ctx.tenantId,
        layer: "execution",
        actor: ctx.actor,
        action: "invite.revoked",
        inputs: { member_id: before.id },
        outputs: { revoked: true },
      });
      return { revoked: true };
    },
  );

  app.post(
    "/members/:id/identity-links",
    async (request: FastifyRequest<{ Params: { id: string }; Body: IdentityLinkBody }>) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, ADMIN);
      await requireAdmin(deps.pool, ctx);
      const before = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
        findMemberById(c, request.params.id),
      );
      if (before === null) throw brainError("agent_not_found", "member not found");
      const surface = parseSurface(request.body?.surface);
      const externalRef = requireString(request.body?.external_ref, "external_ref");
      await withTenantScope(deps.pool, ctx.tenantId, (c) =>
        insertMemberIdentityLink(c, {
          tenantId: ctx.tenantId,
          memberId: request.params.id,
          surface,
          externalRef,
        }),
      );
      const audit = await emitMemberChanged(deps.audit, ctx, "identity_link_added", before, before);
      return { audit_id: audit.id };
    },
  );

  app.delete(
    "/members/:id/identity-links",
    async (request: FastifyRequest<{ Params: { id: string }; Body: IdentityLinkBody }>) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, ADMIN);
      await requireAdmin(deps.pool, ctx);
      const before = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
        findMemberById(c, request.params.id),
      );
      if (before === null) throw brainError("agent_not_found", "member not found");
      const surface = parseSurface(request.body?.surface);
      const externalRef = requireString(request.body?.external_ref, "external_ref");
      await withTenantScope(deps.pool, ctx.tenantId, (c) =>
        deleteMemberIdentityLink(c, { memberId: request.params.id, surface, externalRef }),
      );
      const audit = await emitMemberChanged(
        deps.audit,
        ctx,
        "identity_link_removed",
        before,
        before,
      );
      return { audit_id: audit.id };
    },
  );
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
      details: {
        reason: "actor_unresolved",
        source: "session",
        principal_type: ctx.principalType ?? "unknown",
      },
    });
  }
  const member = await withTenantScope(pool, ctx.tenantId, (c) => findMemberById(c, ctx.actor));
  if (member === null || !member.active) {
    throw brainError("payment_intent_approval_invalid", "actor_unresolved", {
      statusOverride: 403,
      details: { reason: "actor_unresolved" },
    });
  }
  return member;
}

async function requireAdmin(pool: Pool, ctx: ServiceCallContext): Promise<MemberAuthority> {
  const member = await requireAnyMember(pool, ctx);
  if (member.role !== "admin") {
    throw brainError("auth_scope_insufficient", "admin member required");
  }
  return member;
}

interface RevokedSession {
  tokenId: string;
}

/** F3: true once `active=false` or `status='deactivated'`, whichever the update landed on. */
function becomesInactive(member: MemberAuthority): boolean {
  return !member.active || member.status === "deactivated";
}

/**
 * F3: revokes every outstanding `session_refresh_tokens` row for a member,
 * in the caller's transaction, and returns the access-token `jti` (`token_id`)
 * each row carried -- production-tenancy/routes.ts stores the access token's
 * jti alongside its refresh token row at mint time, so this is how a
 * deactivation reaches the still-live access token, not just future refreshes.
 */
async function revokeMemberSessions(
  client: TenantScopedClient,
  memberId: string,
): Promise<RevokedSession[]> {
  const { rows } = await client.query<{ token_id: string }>(
    `UPDATE session_refresh_tokens
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE member_id = $1
        AND revoked_at IS NULL
      RETURNING token_id`,
    [memberId],
  );
  return rows.map((row) => ({ tokenId: row.token_id }));
}

/**
 * F3: caches each revoked session's access-token jti so a request bearing it
 * fails closed immediately instead of waiting out its remaining TTL. Runs
 * after the DB transaction commits (Redis is not part of that transaction);
 * a Redis failure here must not undo an already-committed deactivation, so
 * failures are swallowed -- the `session_refresh_tokens` revocation above
 * already blocks every future refresh regardless.
 */
async function revokeAccessTokenJtis(
  revocation: RevocationStore | undefined,
  revoked: readonly RevokedSession[],
): Promise<void> {
  if (revocation === undefined || revoked.length === 0) return;
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
  await Promise.all(
    revoked.map((session) =>
      revocation.revoke(session.tokenId, expiresAt).catch((err: unknown) => {
        console.warn("[members] access-token revocation cache write failed", err);
      }),
    ),
  );
}

async function assertNotLastAdmin(pool: Pool, ctx: ServiceCallContext): Promise<void> {
  const admins = await withTenantScope(pool, ctx.tenantId, (c) => countActiveAdmins(c));
  if (admins <= 1) {
    throw brainError("payment_intent_approval_invalid", "last_admin_protected", {
      statusOverride: 403,
      details: { reason: "last_admin_protected" },
    });
  }
}

function wouldRemoveAdmin(before: MemberAuthority, body: MemberBody): boolean {
  return (
    before.role === "admin" &&
    before.active &&
    ((body.role !== undefined && body.role !== "admin") ||
      body.active === false ||
      body.status === "deactivated" ||
      body.status === "invited")
  );
}

async function emitMemberChanged(
  audit: AuditEmitter,
  ctx: ServiceCallContext,
  mutation: string,
  before: MemberAuthority | null,
  after: MemberAuthority,
) {
  return audit.emit({
    tenantId: ctx.tenantId,
    layer: "execution",
    actor: ctx.actor,
    action: "member.changed",
    inputs: { mutation, before: before === null ? null : serializeMember(before) },
    outputs: { after: serializeMember(after) },
  });
}

function serializeMember(member: MemberAuthority) {
  return {
    id: member.id,
    tenantId: member.tenantId,
    email: member.email,
    displayName: member.displayName,
    role: member.role,
    status: member.status,
    active: member.active,
    approval: {
      domains: member.approvalDomains,
      perItemLimit: Number(member.perItemLimitCents),
      requiresSecondApproverAbove:
        member.requiresSecondApproverAboveCents === null
          ? null
          : Number(member.requiresSecondApproverAboveCents),
    },
  };
}

async function issueInvite(
  client: TenantScopedClient,
  input: { tenantId: string; memberId: string; tokenHash: string; issuedBy: string },
): Promise<string> {
  await revokeOutstandingInvites(client, input.memberId);
  const { rows } = await client.query<{ expires_at: string }>(
    `INSERT INTO member_invites (tenant_id, member_id, token_hash, expires_at, issued_by)
     VALUES ($1, $2, $3, now() + ($4::text || ' hours')::interval, $5)
     RETURNING expires_at::text`,
    [input.tenantId, input.memberId, input.tokenHash, INVITE_TTL_HOURS, input.issuedBy],
  );
  return rows[0]?.expires_at ?? "";
}

async function revokeOutstandingInvites(
  client: TenantScopedClient,
  memberId: string,
): Promise<void> {
  await client.query(
    `UPDATE member_invites
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE member_id = $1
        AND consumed_at IS NULL
        AND revoked_at IS NULL`,
    [memberId],
  );
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw brainError("request_body_invalid", `${name} required`);
  }
  return value;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, fallback);
}

function parseRole(value: unknown): "admin" | "approver" | "viewer" {
  if (value === "admin" || value === "approver" || value === "viewer") return value;
  throw brainError("request_body_invalid", "invalid member role");
}

function parseStatus(value: unknown): "invited" | "active" | "deactivated" {
  if (value === "invited" || value === "active" || value === "deactivated") return value;
  throw brainError("request_body_invalid", "invalid member status");
}

function parseSurface(value: unknown): MemberIdentitySurface {
  if (value === "slack" || value === "teams" || value === "email") return value;
  throw brainError("request_body_invalid", "invalid member identity surface");
}

function parseDomains(value: unknown): ApprovalDomain[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw brainError("request_body_invalid", "approval.domains required");
  }
  const allowed = new Set(["ap", "ar", "treasury", "payroll", "reconciliation"]);
  if (!value.every((d): d is ApprovalDomain => typeof d === "string" && allowed.has(d))) {
    throw brainError("request_body_invalid", "invalid approval domain");
  }
  return value;
}

function parseCents(value: unknown): bigint {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  throw brainError("request_body_invalid", "invalid cents value");
}

function parseNullableCents(value: unknown): bigint | null {
  if (value === undefined || value === null) return null;
  return parseCents(value);
}
