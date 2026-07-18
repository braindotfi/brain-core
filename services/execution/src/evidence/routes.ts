import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, requireScope, type Scope, type ServiceCallContext } from "@brain/shared";
import type { Pool } from "pg";
import {
  parseEvidenceResolveBody,
  resolveEvidenceRefs,
  unsupportedEvidenceKinds,
} from "./resolve.js";

const READ: Scope = "execution:read";

export interface EvidenceResolveRoutesDeps {
  pool: Pool;
}

export async function registerEvidenceResolveRoutes(
  app: FastifyInstance,
  deps: EvidenceResolveRoutesDeps,
): Promise<void> {
  app.post("/evidence/resolve", async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, READ);
    const refs = parseEvidenceResolveBody(request.body);
    const unsupported = unsupportedEvidenceKinds(refs);
    if (unsupported.length > 0) {
      request.log.warn({ unsupported_kinds: unsupported }, "unsupported evidence resolve kinds");
    }
    const results = await resolveEvidenceRefs(deps.pool, ctx, refs);
    reply.status(200);
    return { results };
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
