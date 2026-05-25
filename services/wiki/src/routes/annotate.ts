/**
 * POST /wiki/annotate
 *
 * Structured human correction. Applied as a new temporal version with
 * provenance=human_confirmed. §3 Layer 2 governance: annotation is also
 * the promotion path for agent-contributed facts whose confidence needs
 * to rise above 0.5.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  brainError,
  isBrainId,
  newWikiEntityId,
  newWikiRelationId,
  requireScope,
  withTenantScope,
  RedisSlidingWindowRateLimiter,
  type Scope,
  type SlidingWindowRateLimiter,
} from "@brain/shared";
import { RELATION_KINDS, WIKI_KINDS, type RelationKind, type WikiKind } from "@brain/schemas";
import { findEntityAsOf, insertEntity } from "../repository/entities.js";
import { insertRelation } from "../repository/relations.js";
import type { WikiDeps } from "../deps.js";

const WRITE_SCOPE: Scope = "wiki:write";

/** Default per-(tenant, principal) annotation rate, env-overridable. */
function annotationRatePerHour(): number {
  const raw = process.env.WIKI_ANNOTATION_RATE_PER_HOUR;
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : 60;
}

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
  // Built once at registration. A compromised Wiki principal could otherwise
  // spam annotations to steer Ledger state (annotation is the promotion path
  // for agent-contributed facts), so we cap attempts per principal per hour.
  const limiter: SlidingWindowRateLimiter =
    deps.annotationRateLimiter ??
    new RedisSlidingWindowRateLimiter(deps.redis, {
      windowSeconds: 3600,
      limit: annotationRatePerHour(),
    });

  app.post("/wiki/annotate", async (request: FastifyRequest, reply) => {
    if (request.principal === undefined) {
      throw brainError("auth_token_missing", "principal required");
    }
    requireScope(request.principal.scopes, WRITE_SCOPE);
    const body = (request.body ?? {}) as Annotation;
    const actor = request.principal.id;
    const tenant = request.principal.tenantId;

    // P0.3: rate-limit BEFORE any Ledger/Wiki write. On limit, audit + 429.
    const decision = await limiter.hit(`wiki:annotate:${tenant}:${actor}`);
    if (!decision.allowed) {
      await deps.audit.emit({
        tenantId: tenant,
        layer: "wiki",
        actor,
        action: "wiki.annotation.rate_limited",
        inputs: { principal_id: actor },
        outputs: { count: decision.count, limit: decision.limit },
      });
      throw brainError(
        "rate_limit_exceeded",
        `annotation rate limit exceeded (${decision.limit}/hour)`,
        { details: { count: decision.count, limit: decision.limit } },
      );
    }

    if (body.target === "entity") {
      return handleEntity(body, reply, deps, tenant, actor);
    }
    if (body.target === "relation") {
      return handleRelation(body, reply, deps, tenant, actor);
    }
    throw brainError("request_body_invalid", "target must be 'entity' or 'relation'");
  });
}

async function handleEntity(
  body: EntityAnnotation,
  reply: FastifyReply,
  deps: WikiDeps,
  tenant: string,
  actor: string,
) {
  if (body.entity_id !== undefined && !isBrainId(body.entity_id, "ent")) {
    throw brainError("request_body_invalid", "entity_id malformed");
  }
  // v0.3 — annotations to financial truth (transaction/account/counterparty/
  // obligation) write through to the Ledger via the /wiki/annotate
  // write-through path; that lands in Phase 4. Phase 3 only accepts
  // annotations to WIKI_KINDS = {policy, agent} which match the narrowed
  // wiki_entities CHECK constraint introduced by migration 0003.
  if (body.kind === undefined || !WIKI_KINDS.includes(body.kind as WikiKind)) {
    throw brainError("request_body_invalid", "unknown entity kind", {
      details: {
        kind: body.kind ?? null,
        allowed: WIKI_KINDS,
        note: "Ledger annotations (account, counterparty, transaction, obligation) require the /wiki/annotate write-through path which lands in refactor-4.",
      },
    });
  }
  const attrs = body.attributes ?? {};
  // SchemaRegistry.validateEntity still accepts ENTITY_KINDS (the union of
  // Ledger + Wiki) because the same JSON Schemas live in schemas/entity/.
  // We pass the narrower WikiKind cast for type safety.
  deps.schemas.validateEntity(body.kind as WikiKind, attrs);

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
      kind: body.kind as WikiKind,
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
  reply: FastifyReply,
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
