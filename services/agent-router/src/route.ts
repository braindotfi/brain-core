/**
 * POST /agents/route — mounts as /v1/agents/route on the execution app.
 *
 * Returns a routing decision. Authenticated; requires `execution:read`. The
 * decision is advisory: the selected agent still proposes through the
 * existing /v1/agents/{id}/propose path under Policy and the §6 gate.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, requireScope, type Scope, type ServiceCallContext } from "@brain/shared";
import type { AgentRouter } from "./router.js";
import type { RoutingInput } from "./types.js";

const SCOPE_ROUTE: Scope = "execution:read";

function assertCtx(request: FastifyRequest): ServiceCallContext {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  return {
    tenantId: request.principal.tenantId,
    actor: request.principal.id,
    requestId: request.id,
    principalType: request.principal.type,
    scopes: request.principal.scopes,
  };
}

interface RouteBody {
  tenant_id?: string;
  event?: string;
  intent?: string;
  context?: Record<string, unknown>;
}

export interface AgentRouterRouteDeps {
  readonly router: AgentRouter;
}

export async function registerAgentRouterRoutes(
  app: FastifyInstance,
  deps: AgentRouterRouteDeps,
): Promise<void> {
  app.post("/agents/route", async (request: FastifyRequest<{ Body: RouteBody }>) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, SCOPE_ROUTE);
    const body = request.body ?? {};
    if (typeof body.tenant_id !== "string" || body.tenant_id.length === 0) {
      throw brainError("request_body_invalid", "`tenant_id` is required");
    }
    // Tenant isolation: the JWT tenant must own the routing request.
    if (body.tenant_id !== ctx.tenantId) {
      throw brainError(
        "auth_scope_insufficient",
        "tenant_id does not match the authenticated tenant",
        {
          details: { tenant_id: body.tenant_id },
        },
      );
    }
    if (body.event === undefined && body.intent === undefined) {
      throw brainError("request_body_invalid", "one of `event` or `intent` is required");
    }
    const input: RoutingInput = {
      tenant_id: body.tenant_id,
      ...(body.event !== undefined ? { event: body.event } : {}),
      ...(body.intent !== undefined ? { intent: body.intent } : {}),
      ...(body.context !== undefined ? { context: body.context } : {}),
    };
    return deps.router.route(ctx, input);
  });
}
