import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, requireScope, type Scope, type ServiceCallContext } from "@brain/shared";
import type { Pool } from "pg";
import { ProposalSnapshotService } from "./service.js";

const READ: Scope = "execution:read";
const WRITE: Scope = "execution:write";

export interface ProposalSnapshotRoutesDeps {
  pool: Pool;
  snapshots?: ProposalSnapshotService;
}

export async function registerProposalSnapshotRoutes(
  app: FastifyInstance,
  deps: ProposalSnapshotRoutesDeps,
): Promise<void> {
  const snapshots = deps.snapshots ?? new ProposalSnapshotService(deps.pool);

  app.post("/proposal-snapshots", async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const ctx = routeCtx(request);
    requireScope(request.principal!.scopes, WRITE);
    const created = await snapshots.create(ctx, objectField(objectBody(request.body), "payload"));
    reply.status(201);
    return created;
  });

  app.get(
    "/proposal-snapshots/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const ctx = routeCtx(request);
      requireScope(request.principal!.scopes, READ);
      const snapshot = await snapshots.get(ctx, request.params.id);
      if (snapshot === null) throw brainError("request_params_invalid", "snapshot not found");
      return snapshot;
    },
  );
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
