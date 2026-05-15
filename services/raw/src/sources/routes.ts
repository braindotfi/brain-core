/**
 * /v1/sources/* HTTP routes. Owned by `services/raw` per Architecture
 * §3.1 (Source-connector lifecycle lives next to the ingestion adapters).
 *
 *   POST   /sources                     connect
 *   GET    /sources                     list
 *   GET    /sources/{source_id}         get
 *   DELETE /sources/{source_id}         disconnect
 *   POST   /sources/{source_id}/sync    sync
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  requireScope,
  type Scope,
  type ServiceCallContext,
} from "@brain/api/shared";
import type { SourceService } from "./SourceService.js";
import {
  recordToWire,
  type SourceStatus,
  type SourceType,
} from "./types.js";

// raw:read / raw:write are the existing Layer-1 scopes. The same scopes
// gate source connection lifecycle since they govern what the source
// pushes into Raw.
const SCOPE_READ: Scope = "raw:read";
const SCOPE_WRITE: Scope = "raw:write";

function assertCtx(request: FastifyRequest): ServiceCallContext {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  return {
    tenantId: request.principal.tenantId,
    actor: request.principal.id,
    requestId: request.id,
  };
}

interface ConnectBody {
  tenantId?: string;
  type?: string;
  credentials?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export async function registerSourceRoutes(
  app: FastifyInstance,
  service: SourceService,
): Promise<void> {
  app.post(
    "/sources",
    async (request: FastifyRequest<{ Body: ConnectBody }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_WRITE);
      const b = request.body ?? {};
      if (b.type === undefined || b.credentials === undefined) {
        throw brainError(
          "request_body_invalid",
          "`type` and `credentials` are required",
        );
      }
      const created = await service.connect(ctx, {
        type: b.type as SourceType,
        credentials: b.credentials,
        ...(b.metadata !== undefined ? { metadata: b.metadata } : {}),
      });
      reply.status(201);
      return recordToWire(created);
    },
  );

  app.get(
    "/sources",
    async (
      request: FastifyRequest<{
        Querystring: {
          tenantId?: string;
          type?: SourceType;
          status?: SourceStatus;
          limit?: string;
          cursor?: string;
        };
      }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_READ);
      const q = request.query;
      const list = await service.list(ctx, {
        ...(q.type !== undefined ? { type: q.type } : {}),
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.limit !== undefined
          ? { limit: Number.parseInt(q.limit, 10) }
          : {}),
      });
      reply.status(200);
      return { data: list.map(recordToWire), next_cursor: null };
    },
  );

  app.get(
    "/sources/:source_id",
    async (
      request: FastifyRequest<{ Params: { source_id: string } }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_READ);
      const record = await service.get(ctx, request.params.source_id);
      if (record === null) {
        throw brainError("source_not_found", "no such source");
      }
      reply.status(200);
      return recordToWire(record);
    },
  );

  app.delete(
    "/sources/:source_id",
    async (
      request: FastifyRequest<{ Params: { source_id: string } }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_WRITE);
      const record = await service.disconnect(ctx, request.params.source_id);
      if (record === null) {
        throw brainError("source_not_found", "no such source");
      }
      reply.status(200);
      return recordToWire(record);
    },
  );

  app.post(
    "/sources/:source_id/sync",
    async (
      request: FastifyRequest<{ Params: { source_id: string } }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_WRITE);
      const job = await service.sync(ctx, request.params.source_id);
      if (job === null) {
        throw brainError("source_not_found", "no such source");
      }
      reply.status(202);
      return job;
    },
  );
}
