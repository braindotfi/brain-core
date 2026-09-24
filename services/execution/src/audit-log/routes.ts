import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, requireScope, type Scope, type ServiceCallContext } from "@brain/shared";
import type { Pool } from "pg";
import { DecisionAuditLogService, type AuditLogFilters } from "./service.js";

const READ: Scope = "execution:read";

export interface DecisionAuditLogRoutesDeps {
  pool: Pool;
  auditLog?: DecisionAuditLogService;
}

export async function registerDecisionAuditLogRoutes(
  app: FastifyInstance,
  deps: DecisionAuditLogRoutesDeps,
): Promise<void> {
  const auditLog = deps.auditLog ?? new DecisionAuditLogService(deps.pool);

  app.get(
    "/audit-log",
    async (
      request: FastifyRequest<{
        Querystring: {
          tenant_id?: string;
          from?: string;
          to?: string;
          actor_type?: string;
          agent?: string;
          decision?: string;
          limit?: string;
          cursor?: string;
        };
      }>,
    ) => {
      const ctx = routeCtx(request);
      requireScope(request.principal!.scopes, READ);
      rejectTenantOverride(request.query.tenant_id, ctx.tenantId);
      return auditLog.list(ctx, parseFilters(request.query));
    },
  );

  app.get("/audit-log/:id", async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const ctx = routeCtx(request);
    requireScope(request.principal!.scopes, READ);
    const entry = await auditLog.get(ctx, request.params.id);
    if (entry === null) throw brainError("request_params_invalid", "audit log entry not found");
    return entry;
  });

  app.post("/audit-log/export", async (request: FastifyRequest<{ Body: unknown }>) => {
    const ctx = routeCtx(request);
    requireScope(request.principal!.scopes, READ);
    const body = objectBody(request.body);
    rejectTenantOverride(readString(body["tenant_id"]), ctx.tenantId);
    return auditLog.exportCsv(ctx, parseFilters(body));
  });
}

function routeCtx(request: FastifyRequest): ServiceCallContext {
  if (request.principal === undefined) throw brainError("auth_token_missing", "principal required");
  return {
    tenantId: request.principal.tenantId,
    actor: request.principal.id,
    requestId: request.id,
    principalType: request.principal.type,
    scopes: request.principal.scopes,
  };
}

function parseFilters(input: Record<string, unknown>): AuditLogFilters {
  const filters: AuditLogFilters = {};
  if (typeof input["from"] === "string") filters.from = input["from"];
  if (typeof input["to"] === "string") filters.to = input["to"];
  if (typeof input["actor_type"] === "string") {
    const actorType = input["actor_type"];
    if (actorType !== "user" && actorType !== "system" && actorType !== "agent") {
      throw brainError("request_body_invalid", "actor_type must be user, system, or agent");
    }
    filters.actor_type = actorType;
  }
  if (typeof input["agent"] === "string") filters.agent = input["agent"];
  if (typeof input["decision"] === "string") filters.decision = input["decision"];
  if (typeof input["cursor"] === "string") filters.cursor = input["cursor"];
  const limit = parseLimit(input["limit"]);
  if (limit !== undefined) filters.limit = limit;
  return filters;
}

function parseLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed))
    throw brainError("request_body_invalid", "limit must be an integer");
  return parsed;
}

function rejectTenantOverride(queryTenantId: string | undefined, ctxTenantId: string): void {
  if (queryTenantId !== undefined && queryTenantId !== ctxTenantId) {
    throw brainError("auth_tenant_mismatch", "tenant_id must match authenticated tenant");
  }
}

function objectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw brainError("request_body_invalid", "body must be an object");
  }
  return body as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
