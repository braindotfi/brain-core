import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, requireScope, withTenantScope, type Scope } from "@brain/shared";
import { searchEntities, semanticSearch } from "../repository/entities.js";
import {
  LEDGER_KINDS,
  WIKI_KINDS,
  type EntityKind,
  type LedgerKind,
  type WikiKind,
} from "@brain/schemas";
import { serializeEntity } from "./entity.js";
import type { WikiDeps } from "../deps.js";

const READ_SCOPE: Scope = "wiki:read";

export async function registerSearch(app: FastifyInstance, deps: WikiDeps): Promise<void> {
  app.get(
    "/wiki/search",
    async (
      request: FastifyRequest<{
        Querystring: {
          kind?: string;
          q?: string;
          semantic?: string;
          since?: string;
          until?: string;
          limit?: string;
          cursor?: string;
        };
      }>,
      reply,
    ) => {
      if (request.principal === undefined) {
        throw brainError("auth_token_missing", "principal required");
      }
      requireScope(request.principal.scopes, READ_SCOPE);

      const limit = Math.min(
        request.query.limit === undefined ? 50 : parseInt(request.query.limit, 10),
        500,
      );
      const kind = request.query.kind;
      if (kind !== undefined) {
        // v0.3 — Wiki search only returns Wiki-resident kinds (policy, agent).
        // Financial-truth kinds (account, counterparty, transaction, obligation)
        // moved to the Ledger; redirect callers explicitly.
        if (LEDGER_KINDS.includes(kind as LedgerKind)) {
          throw brainError(
            "request_params_invalid",
            `'${kind}' is a Ledger kind in v0.3. Use /ledger/${kind === "account" ? "accounts" : kind === "counterparty" ? "counterparties" : kind === "transaction" ? "transactions" : "obligations"} instead.`,
            { details: { kind, redirect: `/ledger/${kind}s` } },
          );
        }
        if (!WIKI_KINDS.includes(kind as WikiKind)) {
          throw brainError("request_params_invalid", "unknown entity kind", {
            details: { kind, allowed: WIKI_KINDS },
          });
        }
      }
      const filters = {
        ...(kind !== undefined ? { kind: kind as EntityKind } : {}),
        ...(request.query.q !== undefined ? { q: request.query.q } : {}),
        ...(request.query.since !== undefined ? { since: parseDate(request.query.since) } : {}),
        ...(request.query.until !== undefined ? { until: parseDate(request.query.until) } : {}),
        limit,
      };

      const results = await withTenantScope(deps.pool, request.principal.tenantId, async (c) => {
        // Semantic path: embed the query and use ivfflat cosine search.
        if (request.query.semantic !== undefined && request.query.semantic !== "") {
          const embedding = await deps.embed.embed(request.query.semantic);
          return semanticSearch(
            c,
            embedding.vector,
            limit,
            kind !== undefined ? (kind as EntityKind) : undefined,
          );
        }
        return searchEntities(c, filters);
      });

      reply.status(200);
      return {
        results: results.map(serializeEntity),
        next_cursor: null, // cursor pagination lands post-MVP
      };
    },
  );
}

function parseDate(v: string): Date {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw brainError("wiki_temporal_range_invalid", "invalid timestamp", { details: { value: v } });
  }
  return d;
}
