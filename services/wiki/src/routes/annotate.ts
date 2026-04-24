/**
 * POST /wiki/annotate
 *
 * Structured human correction. Applied as a new temporal version with
 * provenance=human_confirmed. §3 Layer 2 governance: annotation is also
 * the promotion path for agent-contributed facts whose confidence needs
 * to rise above 0.5.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  isBrainId,
  newWikiEntityId,
  newWikiRelationId,
  requireScope,
  withTenantScope,
  type Scope,
} from "@brain/api/shared";
import {
  ENTITY_KINDS,
  RELATION_KINDS,
  type EntityKind,
  type RelationKind,
} from "../../../../schemas/index.js";
import {
  findEntityAsOf,
  insertEntity,
} from "../repository/entities.js";
import { insertRelation } from "../repository/relations.js";
import type { WikiDeps } from "../deps.js";

const WRITE_SCOPE: Scope = "wiki:write";

interface EntityAnnotation {
  target: "entity";
  entity_id?: string;
  kind?: string;
  attributes?: Record<string, unknown>;
  confidence?: number;
}

interface RelationAnnotation {
  target: "relation";
  src?: string;
  dst?: string;
  kind?: string;
  attributes?: Record<string, unknown>;
  confidence?: number;
}

type Annotation = EntityAnnotation | RelationAnnotation;

export async function registerAnnotate(app: FastifyInstance, deps: WikiDeps): Promise<void> {
  app.post(
    "/wiki/annotate",
    async (request: FastifyRequest, reply) => {
      if (request.principal === undefined) {
        throw brainError("auth_token_missing", "principal required");
      }
      requireScope(request.principal.scopes, WRITE_SCOPE);
      const body = (request.body ?? {}) as Annotation;
      const actor = request.principal.id;
      const tenant = request.principal.tenantId;

      if (body.target === "entity") {
        return handleEntity(body, reply, deps, tenant, actor);
      }
      if (body.target === "relation") {
        return handleRelation(body, reply, deps, tenant, actor);
      }
      throw brainError("request_body_invalid", "target must be 'entity' or 'relation'");
    },
  );
}

async function handleEntity(
  body: EntityAnnotation,
  reply: import("fastify").FastifyReply,
  deps: WikiDeps,
  tenant: string,
  actor: string,
) {
  if (body.entity_id !== undefined && !isBrainId(body.entity_id, "ent")) {
    throw brainError("request_body_invalid", "entity_id malformed");
  }
  if (body.kind === undefined || !ENTITY_KINDS.includes(body.kind as EntityKind)) {
    throw brainError("request_body_invalid", "unknown entity kind");
  }
  const attrs = body.attributes ?? {};
  deps.schemas.validateEntity(body.kind as EntityKind, attrs);

  const newId = body.entity_id ?? newWikiEntityId();
  const now = new Date();

  const row = await withTenantScope(deps.pool, tenant, async (c) => {
    if (body.entity_id !== undefined) {
      const existing = await findEntityAsOf(c, body.entity_id, null);
      if (existing === null) {
        throw brainError("wiki_entity_not_found", "annotation target missing");
      }
    }
    return insertEntity(c, {
      id: newId,
      tenantId: tenant,
      kind: body.kind as EntityKind,
      attributes: attrs,
      embedding: null,
      validFrom: now,
      validTo: null,
      provenance: "human_confirmed",
      confidence: body.confidence ?? 1.0,
      sourceEvidence: [],
      ...(body.entity_id !== undefined ? { supersedes: body.entity_id } : {}),
    });
  });

  await deps.audit.emit({
    tenantId: tenant,
    layer: "wiki",
    actor,
    action: "wiki.annotate.entity",
    inputs: { target_id: body.entity_id ?? null, kind: body.kind },
    outputs: { new_version_id: row.id },
  });

  reply.status(201);
  return { annotation_id: row.id, new_version_id: row.id };
}

async function handleRelation(
  body: RelationAnnotation,
  reply: import("fastify").FastifyReply,
  deps: WikiDeps,
  tenant: string,
  actor: string,
) {
  if (body.src === undefined || !isBrainId(body.src, "ent")) {
    throw brainError("request_body_invalid", "src malformed");
  }
  if (body.dst === undefined || !isBrainId(body.dst, "ent")) {
    throw brainError("request_body_invalid", "dst malformed");
  }
  if (body.kind === undefined || !RELATION_KINDS.includes(body.kind as RelationKind)) {
    throw brainError("request_body_invalid", "unknown relation kind");
  }
  const attrs = body.attributes ?? {};
  deps.schemas.validateRelation(body.kind as RelationKind, attrs);
  const now = new Date();
  const id = newWikiRelationId();

  const row = await withTenantScope(deps.pool, tenant, (c) =>
    insertRelation(c, {
      id,
      tenantId: tenant,
      src: body.src!,
      dst: body.dst!,
      kind: body.kind as RelationKind,
      attributes: attrs,
      validFrom: now,
      validTo: null,
      provenance: "human_confirmed",
      confidence: body.confidence ?? 1.0,
      sourceEvidence: [],
    }),
  );

  await deps.audit.emit({
    tenantId: tenant,
    layer: "wiki",
    actor,
    action: "wiki.annotate.relation",
    inputs: { src: body.src, dst: body.dst, kind: body.kind },
    outputs: { relation_id: row.id },
  });

  reply.status(201);
  return { annotation_id: row.id, new_version_id: row.id };
}
