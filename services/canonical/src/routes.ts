/**
 * Canonical read API (Phase 6 governed data products). The first HTTP surface
 * on the canonical layer: provenance-backed reads of the rich domain records,
 * mounted by services/api under /v1. Read-only and tenant-scoped; every record
 * is returned with its provenance + freshness (see query/obligations.ts).
 */

import { brainError, parsePositiveIntParam, requireScope, type Scope } from "@brain/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CanonicalDeps } from "./deps.js";
import {
  getObligationProduct,
  listObligationProducts,
  type ListObligationsFilter,
} from "./query/obligations.js";

const READ: Scope = "canonical:read";

function requirePrincipal(request: FastifyRequest) {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  return request.principal;
}

function parseDirection(v: string | undefined): "payable" | "receivable" | undefined {
  if (v === undefined) return undefined;
  if (v === "payable" || v === "receivable") return v;
  throw brainError("request_params_invalid", "direction must be payable|receivable");
}

export async function registerCanonicalRoutes(
  app: FastifyInstance,
  deps: CanonicalDeps,
): Promise<void> {
  // GET /canonical/obligations — the AP/AR domain as a governed data product.
  app.get(
    "/canonical/obligations",
    async (
      request: FastifyRequest<{ Querystring: { direction?: string; limit?: string } }>,
      reply: FastifyReply,
    ) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, READ);
      const limit = parsePositiveIntParam("limit", request.query.limit, {
        fallback: 100,
        max: 500,
      });
      const direction = parseDirection(request.query.direction);
      const filter: ListObligationsFilter = {
        limit,
        ...(direction !== undefined ? { direction } : {}),
      };
      const obligations = await listObligationProducts(
        deps.pool,
        { tenantId: principal.tenantId, actor: principal.id },
        filter,
      );
      reply.status(200);
      return { obligations };
    },
  );

  // GET /canonical/obligations/:id — one obligation with provenance + freshness.
  app.get(
    "/canonical/obligations/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, READ);
      const product = await getObligationProduct(
        deps.pool,
        { tenantId: principal.tenantId, actor: principal.id },
        request.params.id,
      );
      if (product === null) {
        throw brainError("obligation_not_found", `no canonical obligation: ${request.params.id}`);
      }
      reply.status(200);
      return product;
    },
  );
}
