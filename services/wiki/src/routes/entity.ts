/**
 * GET /wiki/entity/{entity_id}         — entity + 1-hop neighbors (+ asOf)
 * GET /wiki/entity/{entity_id}/evidence — provenance chain
 * GET /wiki/entity/{entity_id}/history — temporal versions
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  isBrainId,
  requireScope,
  withTenantScope,
  type Scope,
} from "@brain/api/shared";
import {
  findEntityAsOf,
  listEntityVersions,
  type WikiEntityRow,
} from "../repository/entities.js";
import { findOneHopNeighbors } from "../repository/relations.js";
import type { WikiDeps } from "../deps.js";

const READ_SCOPE: Scope = "wiki:read";

export async function registerEntity(app: FastifyInstance, deps: WikiDeps): Promise<void> {
  app.get(
    "/wiki/entity/:entity_id",
    async (
      request: FastifyRequest<{
        Params: { entity_id: string };
        Querystring: { include_neighbors?: string; as_of?: string };
      }>,
      reply,
    ) => {
      assertPrincipal(request);
      requireScope(request.principal!.scopes, READ_SCOPE);
      const id = request.params.entity_id;
      if (!isBrainId(id, "ent")) {
        throw brainError("request_params_invalid", "malformed entity_id");
      }
      const asOf = parseAsOf(request.query.as_of);
      const includeNeighbors = request.query.include_neighbors !== "false";

      const result = await withTenantScope(deps.pool, request.principal!.tenantId, async (c) => {
        const entity = await findEntityAsOf(c, id, asOf);
        if (entity === null) return null;
        const neighbors = includeNeighbors ? await findOneHopNeighbors(c, id, asOf) : [];

        // Fetch neighbor entities too, capped for payload size.
        const neighborEntities = new Map<string, WikiEntityRow>();
        for (const rel of neighbors.slice(0, 25)) {
          const otherId = rel.src === id ? rel.dst : rel.src;
          if (!neighborEntities.has(otherId)) {
            const e = await findEntityAsOf(c, otherId, asOf);
            if (e !== null) neighborEntities.set(otherId, e);
          }
        }
        return { entity, neighbors, neighborEntities };
      });
      if (result === null) {
        throw brainError("wiki_entity_not_found", "no such entity");
      }

      reply.status(200);
      return {
        entity: serializeEntity(result.entity),
        neighbors: result.neighbors
          .slice(0, 25)
          .map((rel) => {
            const otherId = rel.src === id ? rel.dst : rel.src;
            const other = result.neighborEntities.get(otherId);
            if (other === undefined) return null;
            return {
              relation: serializeRelation(rel),
              entity: serializeEntity(other),
            };
          })
          .filter((x) => x !== null),
      };
    },
  );

  app.get(
    "/wiki/entity/:entity_id/evidence",
    async (request: FastifyRequest<{ Params: { entity_id: string } }>, reply) => {
      assertPrincipal(request);
      requireScope(request.principal!.scopes, READ_SCOPE);
      const id = request.params.entity_id;
      if (!isBrainId(id, "ent")) {
        throw brainError("request_params_invalid", "malformed entity_id");
      }
      const versions = await withTenantScope(deps.pool, request.principal!.tenantId, (c) =>
        listEntityVersions(c, id),
      );
      if (versions.length === 0) {
        throw brainError("wiki_entity_not_found", "no such entity");
      }
      reply.status(200);
      return {
        entity_id: id,
        // MVP shape: each version's source_evidence (raw_parsed ids) and
        // provenance. Full chain expansion across raw_artifacts lives in
        // stage-9 E2E reporting.
        chain: versions.map((v) => ({
          version_valid_from: v.valid_from.toISOString(),
          provenance: v.provenance,
          confidence: v.confidence,
          source_evidence: v.source_evidence,
        })),
      };
    },
  );

  app.get(
    "/wiki/entity/:entity_id/history",
    async (request: FastifyRequest<{ Params: { entity_id: string } }>, reply) => {
      assertPrincipal(request);
      requireScope(request.principal!.scopes, READ_SCOPE);
      const id = request.params.entity_id;
      if (!isBrainId(id, "ent")) {
        throw brainError("request_params_invalid", "malformed entity_id");
      }
      const versions = await withTenantScope(deps.pool, request.principal!.tenantId, (c) =>
        listEntityVersions(c, id),
      );
      if (versions.length === 0) {
        throw brainError("wiki_entity_not_found", "no such entity");
      }
      reply.status(200);
      return {
        entity_id: id,
        versions: versions.map(serializeEntity),
      };
    },
  );
}

export function serializeEntity(e: WikiEntityRow): Record<string, unknown> {
  return {
    id: e.id,
    kind: e.kind,
    attributes: e.attributes,
    valid_from: e.valid_from.toISOString(),
    valid_to: e.valid_to === null ? null : e.valid_to.toISOString(),
    provenance: e.provenance,
    confidence: e.confidence,
    source_evidence: e.source_evidence,
  };
}

export function serializeRelation(r: { id: string; src: string; dst: string; kind: string; attributes: Record<string, unknown>; valid_from: Date; valid_to: Date | null; provenance: string; confidence: number }): Record<string, unknown> {
  return {
    id: r.id,
    src: r.src,
    dst: r.dst,
    kind: r.kind,
    attributes: r.attributes,
    valid_from: r.valid_from.toISOString(),
    valid_to: r.valid_to === null ? null : r.valid_to.toISOString(),
    provenance: r.provenance,
    confidence: r.confidence,
  };
}

function assertPrincipal(request: FastifyRequest): void {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
}

function parseAsOf(v: string | undefined): Date | null {
  if (v === undefined) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw brainError("wiki_temporal_range_invalid", "as_of is not a valid ISO timestamp");
  }
  return d;
}
