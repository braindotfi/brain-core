import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  newUserId,
  requireScope,
  withTenantScope,
  type AuditEmitter,
  type Scope,
  type ServiceCallContext,
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

export interface MemberRoutesDeps {
  pool: Pool;
  audit: AuditEmitter;
}

interface MemberBody {
  id?: string;
  email?: string;
  display_name?: string;
  role?: string;
  active?: boolean;
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
    async (request: FastifyRequest<{ Querystring: { role?: string; domain?: string } }>) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, READ);
      await requireAnyMember(deps.pool, ctx);
      const filters = {
        limit: 500,
        ...(request.query.role !== undefined ? { role: request.query.role } : {}),
        ...(request.query.domain !== undefined ? { domain: request.query.domain } : {}),
      };
      const rows = await withTenantScope(deps.pool, ctx.tenantId, (c) => listMembers(c, filters));
      return { members: rows.map(serializeMember) };
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
    const after = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
      insertMember(c, {
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
      }),
    );
    const audit = await emitMemberChanged(deps.audit, ctx, "created", before, after);
    reply.status(201);
    return { member: serializeMember(after), audit_id: audit.id };
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
      const after = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
        updateMember(c, {
          id: request.params.id,
          ...(body.role !== undefined ? { role: parseRole(body.role) } : {}),
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
        }),
      );
      if (after === null) throw brainError("agent_not_found", "member not found");
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
    const after = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
      updateMember(c, { id: request.params.id, active: false }),
    );
    if (after === null) throw brainError("agent_not_found", "member not found");
    const audit = await emitMemberChanged(deps.audit, ctx, "deactivated", before, after);
    return { member: serializeMember(after), audit_id: audit.id };
  });

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
    ((body.role !== undefined && body.role !== "admin") || body.active === false)
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

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw brainError("request_body_invalid", `${name} required`);
  }
  return value;
}

function parseRole(value: unknown): "admin" | "approver" | "viewer" {
  if (value === "admin" || value === "approver" || value === "viewer") return value;
  throw brainError("request_body_invalid", "invalid member role");
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
