/**
 * DELETE /v1/tenants/{id} — GDPR right-to-erasure.
 *
 * Auth posture: a tenant may delete only its own data. Requires
 *   principal_type=user
 *   principal.tenantId === :id
 *   execution:admin scope
 *   a live, active admin `members` row (re-checked in the service -- see
 *   F2 in TenantDeletionService.deleteTenant; scope alone is not enough
 *   because it can be stale relative to a demotion)
 * Any other principal type (agent, api_partner) or a tenant mismatch is
 * rejected with auth_tenant_mismatch. This makes the endpoint
 * representative-driven: the tenant's admin is the authorized agent of the
 * data-subject erasure request.
 *
 * F2 confirmation step: given the blast radius (irreversible erasure of
 * every tenant-scoped row plus an enqueued blob purge), the caller must
 * echo the target tenant id back in the request body as `confirm`. This is
 * intentionally cheap -- no new token, no second endpoint, no email round
 * trip -- but it rules out a single blind DELETE (e.g. a CSRF'd request, or
 * a copy-pasted curl command against the wrong tenant) succeeding on scope
 * and tenant match alone.
 *
 * On success returns 200 with per-table deletion counts. The Merkle audit
 * chain itself is preserved — the deletion is recorded as a
 * `tenant.deleted` audit event so the action is itself verifiable.
 */

import type { FastifyInstance } from "fastify";
import { brainError, requireScope } from "@brain/shared";
import type { TenantDeletionService } from "./service.js";

export interface TenantDeletionRouteDeps {
  service: TenantDeletionService;
}

export async function registerTenantDeletionRoute(
  app: FastifyInstance,
  deps: TenantDeletionRouteDeps,
): Promise<void> {
  app.delete<{ Params: { id: string }; Body?: { confirm?: unknown } }>(
    "/tenants/:id",
    async (request, reply) => {
      if (request.principal === undefined) {
        throw brainError("auth_token_missing", "principal required");
      }
      if (request.principal.type !== "user") {
        throw brainError(
          "auth_scope_insufficient",
          "tenant deletion requires principal_type=user",
        );
      }
      requireScope(request.principal.scopes, "execution:admin");
      const targetId = request.params.id;
      if (request.principal.tenantId !== targetId) {
        throw brainError("auth_tenant_mismatch", "tenant deletion is self-only", {
          details: { principal_tenant: request.principal.tenantId, target_tenant: targetId },
        });
      }
      if (request.body?.confirm !== targetId) {
        throw brainError(
          "request_body_invalid",
          "confirm must equal the tenant id being deleted",
          { details: { required_field: "confirm" } },
        );
      }
      // The service re-checks the caller is a live, active admin member
      // (F2) before deleting anything -- see TenantDeletionService.deleteTenant.
      const result = await deps.service.deleteTenant(
        { tenantId: targetId, actor: request.principal.id },
        targetId,
      );
      reply.status(200);
      return result;
    },
  );
}
