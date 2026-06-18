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
import {
  getGlAccountProduct,
  listGlAccountProducts,
  type ListGlAccountsFilter,
} from "./query/gl-accounts.js";
import { getJournalEntryProduct, listJournalEntryProducts } from "./query/journal-entries.js";

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

  // GET /canonical/gl-accounts — the chart of accounts as a governed data product.
  app.get(
    "/canonical/gl-accounts",
    async (
      request: FastifyRequest<{ Querystring: { classification?: string; limit?: string } }>,
      reply: FastifyReply,
    ) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, READ);
      const limit = parsePositiveIntParam("limit", request.query.limit, {
        fallback: 100,
        max: 500,
      });
      const filter: ListGlAccountsFilter = {
        limit,
        ...(request.query.classification !== undefined
          ? { classification: request.query.classification }
          : {}),
      };
      const gl_accounts = await listGlAccountProducts(
        deps.pool,
        { tenantId: principal.tenantId, actor: principal.id },
        filter,
      );
      reply.status(200);
      return { gl_accounts };
    },
  );

  // GET /canonical/gl-accounts/:id — one GL account with provenance + freshness.
  app.get(
    "/canonical/gl-accounts/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, READ);
      const product = await getGlAccountProduct(
        deps.pool,
        { tenantId: principal.tenantId, actor: principal.id },
        request.params.id,
      );
      if (product === null) {
        throw brainError("ledger_row_not_found", `no canonical gl account: ${request.params.id}`);
      }
      reply.status(200);
      return product;
    },
  );

  // GET /canonical/journal-entries — double-entry journals as governed products.
  app.get(
    "/canonical/journal-entries",
    async (request: FastifyRequest<{ Querystring: { limit?: string } }>, reply: FastifyReply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, READ);
      const limit = parsePositiveIntParam("limit", request.query.limit, {
        fallback: 100,
        max: 500,
      });
      const journal_entries = await listJournalEntryProducts(
        deps.pool,
        { tenantId: principal.tenantId, actor: principal.id },
        limit,
      );
      reply.status(200);
      return { journal_entries };
    },
  );

  // GET /canonical/journal-entries/:id — one journal entry with its lines.
  app.get(
    "/canonical/journal-entries/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, READ);
      const product = await getJournalEntryProduct(
        deps.pool,
        { tenantId: principal.tenantId, actor: principal.id },
        request.params.id,
      );
      if (product === null) {
        throw brainError(
          "ledger_row_not_found",
          `no canonical journal entry: ${request.params.id}`,
        );
      }
      reply.status(200);
      return product;
    },
  );
}
