import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  isBrainId,
  requireScope,
  type ApiSlidingWindowRateLimiter,
} from "@brain/shared";
import { tenantDeletionJobToWire } from "./admin-delete.js";
import type { AdminTenantDeletionService } from "./admin-delete.js";

const RATE_POLICY = {
  tierId: "admin-tenant-delete-v1",
  entitlementVersion: 1,
  windowSeconds: 60,
  keyLimit: 10,
  tenantLimit: 10,
} as const;

export interface AdminTenantDeletionRouteDeps {
  service: AdminTenantDeletionService;
  rateLimiter: ApiSlidingWindowRateLimiter;
}

function requireDeletionCaller(request: FastifyRequest) {
  const principal = request.principal;
  if (principal === undefined) throw brainError("auth_token_missing", "principal required");
  if (principal.type !== "api_partner" || request.apiKeyId !== undefined) {
    throw brainError(
      "auth_scope_insufficient",
      "tenant deletion requires a dedicated admin credential",
    );
  }
  requireScope(principal.scopes, "tenant:delete");
  return principal;
}

async function enforceRateLimit(
  request: FastifyRequest,
  deps: AdminTenantDeletionRouteDeps,
  callerId: string,
): Promise<void> {
  let decision;
  try {
    decision = await deps.rateLimiter.hit({
      keyBucket: `admin-tenant-delete:${callerId}`,
      tenantBucket: `admin-tenant-delete-total:${callerId}`,
      requestId: request.id,
      policy: RATE_POLICY,
    });
  } catch {
    throw brainError("dependency_unavailable", "tenant deletion rate limiter unavailable");
  }
  if (!decision.allowed) {
    throw brainError("rate_limit_exceeded", "tenant deletion rate limit exceeded", {
      details: { limit: 10, window_seconds: 60 },
    });
  }
}

export async function registerAdminTenantDeletionRoutes(
  app: FastifyInstance,
  deps: AdminTenantDeletionRouteDeps,
): Promise<void> {
  app.post<{ Params: { tenant_id: string } }>(
    "/admin/tenants/:tenant_id/delete",
    async (request, reply) => {
      const caller = requireDeletionCaller(request);
      if (!isBrainId(request.params.tenant_id, "tnt")) {
        throw brainError("request_params_invalid", "malformed tenant id");
      }
      await enforceRateLimit(request, deps, caller.id);
      const result = await deps.service.request(request.params.tenant_id, caller.id, request.id);
      reply.status(202);
      return tenantDeletionJobToWire(result.row);
    },
  );

  app.get<{ Params: { job_id: string } }>("/admin/tenant-deletions/:job_id", async (request) => {
    requireDeletionCaller(request);
    if (!isBrainId(request.params.job_id, "tdel")) {
      throw brainError("request_params_invalid", "malformed tenant deletion job id");
    }
    const row = await deps.service.find(request.params.job_id);
    if (row === null) {
      throw brainError("tenant_deletion_job_not_found", "tenant deletion job not found");
    }
    return tenantDeletionJobToWire(row);
  });
}
