import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, requireScope, type Scope, type ServiceCallContext } from "@brain/shared";
import type { RoboAskFromContextRequest, RoboBriefRequest, RoboServiceDeps } from "./types.js";
import { RoboService } from "./service.js";

const READ_SCOPE: Scope = "wiki:read";

export interface RoboRoutesDeps extends RoboServiceDeps {
  service?: RoboService;
}

export async function registerRoboRoutes(
  app: FastifyInstance,
  deps: RoboRoutesDeps,
): Promise<void> {
  const service = deps.service ?? new RoboService(deps);

  app.post("/robo/brief", async (request: FastifyRequest<{ Body: RoboBriefRequest }>, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, READ_SCOPE);
    const body = request.body ?? ({} as RoboBriefRequest);
    if (typeof body.tenant_id !== "string" || body.tenant_id.length === 0) {
      throw brainError("request_body_invalid", "tenant_id is required");
    }
    if (body.as_of !== undefined && typeof body.as_of !== "string") {
      throw brainError("request_body_invalid", "as_of must be a string");
    }
    const result = await service.createBrief(ctx, body);
    reply.status(200);
    return result;
  });

  app.get("/robo/overnight", async (request, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, READ_SCOPE);
    const result = await service.getOvernight(ctx);
    reply.status(200);
    return result;
  });

  app.get(
    "/robo/brief/:tenant_id",
    async (
      request: FastifyRequest<{
        Params: { tenant_id: string };
        Querystring: { date?: string };
      }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, READ_SCOPE);
      if (typeof request.query.date !== "string" || request.query.date.length === 0) {
        throw brainError("request_params_invalid", "date is required");
      }
      const result = await service.getBrief(ctx, request.params.tenant_id, request.query.date);
      reply.status(200);
      return result;
    },
  );

  app.post(
    "/robo/ask-from-context",
    async (request: FastifyRequest<{ Body: RoboAskFromContextRequest }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, READ_SCOPE);
      const body = request.body ?? ({} as RoboAskFromContextRequest);
      if (typeof body.tenant_id !== "string" || body.tenant_id.length === 0) {
        throw brainError("request_body_invalid", "tenant_id is required");
      }
      const result = await service.askFromContext(ctx, body);
      if (body.open_thread === false) {
        reply.status(200);
        return result;
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      writeSse(reply.raw, "thread", { thread_id: result.thread_id });
      writeSse(reply.raw, "message", result.first_response);
      writeSse(reply.raw, "done", {});
      reply.raw.end();
      return undefined;
    },
  );
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

function writeSse(stream: NodeJS.WritableStream, event: string, data: unknown): void {
  stream.write(`event: ${event}\n`);
  stream.write(`data: ${JSON.stringify(data)}\n\n`);
}
