/**
 * DELETE /v1/tenants/{id} — GDPR right-to-erasure.
 *
 * Auth posture: a tenant may delete only its own data. Requires
 *   principal_type=user
 *   principal.tenantId === :id
 * Any other principal type (agent, api_partner) or a tenant mismatch is
 * rejected with auth_tenant_mismatch. This makes the endpoint
 * representative-driven: the tenant's user is the authorized agent of the
 * data-subject erasure request.
 *
 * On success returns 200 with per-table deletion counts. The Merkle audit
 * chain itself is preserved — the deletion is recorded as a
 * `tenant.deleted` audit event so the action is itself verifiable.
 */

import type { FastifyInstance } from "fastify";
import { brainError } from "@brain/shared";
import type { TenantDeletionService } from "./service.js";

export interface TenantDeletionRouteDeps {
  service: TenantDeletionService;
}

export async function registerTenantDeletionRoute(
  app: FastifyInstance,
  deps: TenantDeletionRouteDeps,
): Promise<void> {
  app.delete<{ Params: { id: string } }>("/tenants/:id", async (request, reply) => {
    if (request.principal === undefined) {
      throw brainError("auth_token_missing", "principal required");
    }
    if (request.principal.type !== "user") {
      throw brainError("auth_scope_insufficient", "tenant deletion requires principal_type=user");
    }
    const targetId = request.params.id;
    if (request.principal.tenantId !== targetId) {
      throw brainError("auth_tenant_mismatch", "tenant deletion is self-only", {
        details: { principal_tenant: request.principal.tenantId, target_tenant: targetId },
      });
    }
    const result = await deps.service.deleteTenant(
      { tenantId: targetId, actor: request.principal.id },
      targetId,
    );
    reply.status(200);
    return result;
  });
}
