/**
 * H-07 Proof API route — GET /v1/proof/{action_id}.
 *
 * The flagship trust artifact: a CFO/auditor fetches one canonical, verifiable
 * proof for an action. Tenant-isolated by RLS (a cross-tenant or unknown action
 * resolves to null → 404, so existence is never leaked). The route is a thin
 * shell over an injectable `buildProof` so it is unit-testable without a pool;
 * `poolProofBuilder` is the production wiring (fetch → assemble → Wiki narrative).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { brainError, requireScope, withTenantScope, type Proof, type Scope } from "@brain/shared";
import { renderProofExplanation } from "@brain/wiki";
import { assembleProof } from "./assembler.js";
import { fetchProofSources, type FetchProofOptions } from "./fetchProofSources.js";

const READ: Scope = "audit:read";

export interface ProofRouteDeps {
  /** Resolve the full Proof for an action within a tenant; null => 404. */
  buildProof(tenantId: string, actionId: string): Promise<Proof | null>;
}

/** Production builder: tenant-scoped fetch → pure assemble → Wiki narrative. */
export function poolProofBuilder(
  pool: Pool,
  opts: FetchProofOptions,
): ProofRouteDeps["buildProof"] {
  return async (tenantId, actionId) => {
    const sources = await withTenantScope(pool, tenantId, (c) =>
      fetchProofSources(c, tenantId, actionId, opts),
    );
    if (sources === null) return null;
    const core = assembleProof(sources);
    return { ...core, human_explanation: renderProofExplanation(core) };
  };
}

export async function registerProofRoutes(
  app: FastifyInstance,
  deps: ProofRouteDeps,
): Promise<void> {
  app.get(
    "/proof/:action_id",
    async (request: FastifyRequest<{ Params: { action_id: string } }>, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw brainError("auth_token_missing", "principal required");
      }
      requireScope(principal.scopes, READ);
      const proof = await deps.buildProof(principal.tenantId, request.params.action_id);
      if (proof === null) {
        // 404 with a neutral code — do not leak whether the action exists for
        // another tenant.
        throw brainError("proof_not_found", "no proof for that action", { statusOverride: 404 });
      }
      reply.status(200);
      return proof;
    },
  );
}
