import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, requireScope, type Scope, type ServiceCallContext } from "@brain/shared";
import type { Pool } from "pg";
import {
  RulesEngineService,
  assertRuleAgent,
  type RuleAuthority,
  type RuleCreateInput,
  type RulePatchInput,
} from "./rules-engine.js";

const READ: Scope = "execution:read";
const ADMIN: Scope = "execution:admin";

export interface RulesRoutesDeps {
  pool: Pool;
  rules?: RulesEngineService;
}

export async function registerRulesRoutes(
  app: FastifyInstance,
  deps: RulesRoutesDeps,
): Promise<void> {
  const rules = deps.rules ?? new RulesEngineService(deps.pool);

  app.get(
    "/rules",
    async (request: FastifyRequest<{ Querystring: { agent?: string; tenant_id?: string } }>) => {
      const ctx = routeCtx(request);
      requireScope(request.principal!.scopes, READ);
      rejectTenantOverride(request.query.tenant_id, ctx.tenantId);
      return {
        rules: await rules.list(ctx, {
          ...(request.query.agent !== undefined ? { agent: request.query.agent } : {}),
        }),
      };
    },
  );

  app.get("/rules/:id", async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const ctx = routeCtx(request);
    requireScope(request.principal!.scopes, READ);
    const rule = await rules.get(ctx, request.params.id);
    if (rule === null) throw brainError("request_params_invalid", "rule not found");
    return rule;
  });

  app.post("/rules", async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const ctx = routeCtx(request);
    requireScope(request.principal!.scopes, ADMIN);
    const created = await rules.create(ctx, parseCreateRule(request.body));
    reply.status(201);
    return created;
  });

  app.patch(
    "/rules/:id",
    async (request: FastifyRequest<{ Params: { id: string }; Body: unknown }>) => {
      const ctx = routeCtx(request);
      requireScope(request.principal!.scopes, ADMIN);
      return rules.patch(ctx, request.params.id, parsePatchRule(request.body));
    },
  );

  app.delete("/rules/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const ctx = routeCtx(request);
    requireScope(request.principal!.scopes, ADMIN);
    await rules.delete(ctx, request.params.id);
    reply.status(204);
    return null;
  });

  app.post("/rules/preview", async (request: FastifyRequest<{ Body: unknown }>) => {
    const ctx = routeCtx(request);
    requireScope(request.principal!.scopes, READ);
    const input = parsePreview(request.body);
    return rules.preview(ctx, input);
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

function rejectTenantOverride(queryTenantId: string | undefined, ctxTenantId: string): void {
  if (queryTenantId !== undefined && queryTenantId !== ctxTenantId) {
    throw brainError("auth_tenant_mismatch", "tenant_id must match authenticated tenant");
  }
}

function parseCreateRule(body: unknown): RuleCreateInput {
  const record = objectBody(body);
  const agent = stringField(record, "agent");
  assertRuleAgent(agent);
  const authority = authorityField(record, "authority");
  return {
    agent,
    decision: stringField(record, "decision"),
    condition: objectField(record, "condition"),
    authority,
    ...(record["priority"] !== undefined ? { priority: numberField(record, "priority") } : {}),
    ...(record["enabled"] !== undefined ? { enabled: booleanField(record, "enabled") } : {}),
  };
}

function parsePatchRule(body: unknown): RulePatchInput {
  const record = objectBody(body);
  const patch: RulePatchInput = {};
  if (record["agent"] !== undefined) {
    const agent = stringField(record, "agent");
    assertRuleAgent(agent);
    patch.agent = agent;
  }
  if (record["decision"] !== undefined) patch.decision = stringField(record, "decision");
  if (record["condition"] !== undefined) patch.condition = objectField(record, "condition");
  if (record["authority"] !== undefined) patch.authority = authorityField(record, "authority");
  if (record["priority"] !== undefined) patch.priority = numberField(record, "priority");
  if (record["enabled"] !== undefined) patch.enabled = booleanField(record, "enabled");
  return patch;
}

function parsePreview(body: unknown): { agent: string; payload: Record<string, unknown> } {
  const record = objectBody(body);
  return {
    agent: stringField(record, "agent"),
    payload: objectField(record, "payload"),
  };
}

function objectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw brainError("request_body_invalid", "body must be an object");
  }
  return body as Record<string, unknown>;
}

function objectField(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = record[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw brainError("request_body_invalid", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw brainError("request_body_invalid", `${field} must be a string`);
  }
  return value;
}

function authorityField(record: Record<string, unknown>, field: string): RuleAuthority {
  const value = stringField(record, field);
  if (value !== "auto" && value !== "propose" && value !== "deny") {
    throw brainError("request_body_invalid", `${field} must be auto, propose, or deny`);
  }
  return value;
}

function numberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw brainError("request_body_invalid", `${field} must be an integer`);
  }
  return value;
}

function booleanField(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw brainError("request_body_invalid", `${field} must be a boolean`);
  }
  return value;
}
