import { brainError, requireScope, type Scope, type ServiceCallContext } from "@brain/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { decodeState, type NylasAdapter } from "./adapter.js";
import { NylasGrantStore } from "./store.js";
import { registerProposalThreadRoute } from "./thread-route.js";
import { registerNylasWebhook } from "./webhook.js";

const READ: Scope = "execution:read";
const ADMIN: Scope = "execution:admin";

export interface NylasRoutesDeps {
  readonly pool: Pool;
  readonly adapter: NylasAdapter;
  readonly redirectUri: string;
  readonly webhookSecret?: string;
}

export async function registerNylasRoutes(
  app: FastifyInstance,
  deps: NylasRoutesDeps,
): Promise<void> {
  const store = new NylasGrantStore(deps.pool, deps.adapter);

  app.get("/integrations/nylas/status", async (request, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, READ);
    const grant = await store.get(ctx);
    reply.status(200);
    if (grant === null) return { connected: false };
    return {
      connected: true,
      provider: grant.provider,
      email: grant.email,
      connected_at: grant.connected_at,
    };
  });

  app.post("/integrations/nylas/connect", async (request, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, ADMIN);
    const authUrl = deps.adapter.getAuthUrl({
      tenantId: ctx.tenantId,
      redirectUri: deps.redirectUri,
    });
    reply.status(200);
    return { authUrl };
  });

  app.get(
    "/integrations/nylas/callback",
    async (request: FastifyRequest<{ Querystring: { code?: string; state?: string } }>, reply) => {
      const code = request.query.code;
      const state = request.query.state;
      if (typeof code !== "string" || typeof state !== "string") {
        throw brainError("request_params_invalid", "code and state are required");
      }
      const decoded = decodeState(state);
      const ctx = { ...assertCtx(request), tenantId: decoded.tenantId };
      const grant = await deps.adapter.exchangeCode({ code, state, redirectUri: deps.redirectUri });
      await store.upsert(ctx, grant);
      reply.redirect("/settings/sources?connected=email", 302);
    },
  );

  app.post("/integrations/nylas/disconnect", async (request, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, ADMIN);
    await store.disconnect(ctx);
    reply.status(200);
    return { ok: true };
  });

  await registerProposalThreadRoute(app, { pool: deps.pool, adapter: deps.adapter });

  await registerNylasWebhook(app, {
    pool: deps.pool,
    ...(deps.webhookSecret !== undefined ? { webhookSecret: deps.webhookSecret } : {}),
  });
}

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
