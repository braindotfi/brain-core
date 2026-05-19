/**
 * /memory/* routes — v0.3 Layer 3 narrative memory.
 *
 *   GET  /memory/pages
 *   GET  /memory/pages/{slug_or_id}
 *   POST /memory/regenerate
 *   GET  /memory/search
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, requireScope, type Scope, type ServiceCallContext } from "@brain/shared";
import type { WikiPageService } from "../pages/WikiPageService.js";

const READ: Scope = "wiki:read";

function ctx(request: FastifyRequest): ServiceCallContext {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  return {
    tenantId: request.principal.tenantId,
    actor: request.principal.id,
    requestId: request.id,
  };
}

export async function registerMemoryRoutes(
  app: FastifyInstance,
  service: WikiPageService,
): Promise<void> {
  app.get(
    "/memory/pages",
    async (
      request: FastifyRequest<{
        Querystring: { page_type?: string; q?: string; limit?: string };
      }>,
      reply,
    ) => {
      const c = ctx(request);
      requireScope(request.principal!.scopes, READ);
      const limit = parseLimit(request.query.limit);
      const result = await service.listPages(c, {
        ...(request.query.page_type !== undefined
          ? { page_type: request.query.page_type as never }
          : {}),
        ...(request.query.q !== undefined ? { q: request.query.q } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      reply.status(200);
      return result;
    },
  );

  app.get(
    "/memory/pages/:slug_or_id",
    async (request: FastifyRequest<{ Params: { slug_or_id: string } }>, reply) => {
      const c = ctx(request);
      requireScope(request.principal!.scopes, READ);
      const decoded = decodeURIComponent(request.params.slug_or_id);
      const page = await service.getPage(c, decoded);
      if (page === null) {
        throw brainError("wiki_page_not_found", "no such page", {
          details: { slug_or_id: decoded },
        });
      }
      reply.status(200);
      return page;
    },
  );

  app.post(
    "/memory/regenerate",
    async (request: FastifyRequest<{ Body: { slug_or_id?: string } }>, reply) => {
      const c = ctx(request);
      requireScope(request.principal!.scopes, READ);
      const slugOrId = request.body?.slug_or_id;
      if (slugOrId === undefined) {
        throw brainError("request_body_invalid", "slug_or_id required");
      }
      const page = await service.regenerate(c, slugOrId);
      reply.status(200);
      return page;
    },
  );

  app.get(
    "/memory/search",
    async (request: FastifyRequest<{ Querystring: { q?: string; limit?: string } }>, reply) => {
      const c = ctx(request);
      requireScope(request.principal!.scopes, READ);
      const q = request.query.q;
      if (q === undefined || q.length === 0) {
        throw brainError("request_params_invalid", "q query param required");
      }
      const limit = parseLimit(request.query.limit) ?? 20;
      const results = await service.search(c, q, limit);
      reply.status(200);
      return { results };
    },
  );
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return n;
}
