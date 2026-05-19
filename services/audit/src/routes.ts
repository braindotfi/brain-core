/**
 * Audit routes: 5 core endpoints + 3 webhook endpoint management routes.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  newWebhookEndpointId,
  requireScope,
  withTenantScope,
  type Scope,
} from "@brain/shared";
import { FORWARDED_EVENTS, generateWebhookSecret } from "@brain/shared";
import { buildTree, makeProof, verifyProof } from "./merkle.js";
import {
  findEvent,
  findEventsByEntity,
  findLatestAnchor,
  listEventsForAnchor,
  queryEvents,
  SUPPORTED_AUDIT_ENTITY_TYPES,
  type AuditEventRow,
} from "./repository.js";
import { deleteWebhookEndpoint, insertWebhookEndpoint, listWebhookEndpoints } from "./webhooks.js";
import type { AuditDeps } from "./deps.js";

const READ: Scope = "audit:read";
const WRITE: Scope = "audit:write";

export async function registerAuditRoutes(app: FastifyInstance, deps: AuditDeps): Promise<void> {
  // GET /audit/events — filter by layer/since/until
  app.get(
    "/audit/events",
    async (
      request: FastifyRequest<{
        Querystring: { layer?: string; since?: string; until?: string; limit?: string };
      }>,
      reply,
    ) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, READ);
      const limit = Math.min(
        request.query.limit === undefined ? 100 : Number.parseInt(request.query.limit, 10),
        500,
      );
      const rows = await withTenantScope(deps.pool, principal.tenantId, (c) =>
        queryEvents(c, {
          ...(request.query.layer !== undefined ? { layer: request.query.layer } : {}),
          ...(request.query.since !== undefined ? { since: new Date(request.query.since) } : {}),
          ...(request.query.until !== undefined ? { until: new Date(request.query.until) } : {}),
          limit,
        }),
      );
      reply.status(200);
      return { events: rows.map(serializeEvent) };
    },
  );

  // GET /audit/event/:id — single event + Merkle inclusion proof vs the
  // containing anchor (if one exists).
  app.get(
    "/audit/event/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, READ);
      const result = await withTenantScope(deps.pool, principal.tenantId, async (c) => {
        const event = await findEvent(c, request.params.id);
        if (event === null) return null;
        const anchor = await findLatestAnchor(c);
        // Build proof against the anchor's event window.
        let proofHex: string[] = [];
        let rootHex: string | null = null;
        if (anchor !== null) {
          const events = await listEventsForAnchor(c, anchor.period_start, anchor.period_end);
          const idx = events.findIndex((e) => e.id === event.id);
          if (idx !== -1) {
            const tree = buildTree(events.map((e) => e.event_hash));
            proofHex = makeProof(tree, idx).map((b) => b.toString("hex"));
            rootHex = tree.root.toString("hex");
          }
        }
        return { event, proof: proofHex, root: rootHex, anchorId: anchor?.id ?? null };
      });
      if (result === null) {
        throw brainError("audit_event_not_found", "no such audit event");
      }
      reply.status(200);
      return {
        event: serializeEvent(result.event),
        inclusion_proof: result.proof,
        merkle_root: result.root,
        anchor_id: result.anchorId,
      };
    },
  );

  // GET /audit/entity/:entityType/:entityId — every event touching a
  // Ledger row. Implements the OpenAPI v0.2 contract; the field map in
  // repository.ts ENTITY_FIELD_MAP determines which JSONB keys count as
  // "touching" the entity.
  app.get(
    "/audit/entity/:entityType/:entityId",
    async (
      request: FastifyRequest<{
        Params: { entityType: string; entityId: string };
        Querystring: { limit?: string };
      }>,
      reply,
    ) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, READ);
      const { entityType, entityId } = request.params;

      if (!SUPPORTED_AUDIT_ENTITY_TYPES.includes(entityType)) {
        throw brainError("request_params_invalid", "unsupported entityType", {
          details: { entityType, supported: SUPPORTED_AUDIT_ENTITY_TYPES },
        });
      }
      // Defensive: an entityId that contains nothing useful won't hit any
      // index and is almost always a malformed call.
      if (entityId.length === 0 || entityId.length > 64) {
        throw brainError("request_params_invalid", "entityId malformed");
      }

      const limit = Math.min(
        request.query.limit === undefined ? 200 : Number.parseInt(request.query.limit, 10) || 200,
        500,
      );

      const rows = await withTenantScope(deps.pool, principal.tenantId, (c) =>
        findEventsByEntity(c, entityType, entityId, limit),
      );

      reply.status(200);
      return {
        entity_type: entityType,
        entity_id: entityId,
        events: rows.map(serializeEvent),
      };
    },
  );

  // POST /audit/export — queue a JSONL/CSV export job. Returns a job id.
  app.post(
    "/audit/export",
    async (
      request: FastifyRequest<{
        Body: { format?: "jsonl" | "csv"; since?: string; until?: string };
      }>,
      reply,
    ) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, READ);
      const body = request.body ?? {};
      if (body.format !== "jsonl" && body.format !== "csv") {
        throw brainError("request_body_invalid", "format must be jsonl or csv");
      }
      // Stage-7 enqueues the job; the actual BullMQ worker that materializes
      // the export file lands alongside the object-store writer in stage-8.
      const jobId = `exp_${Date.now().toString(36)}`;
      await deps.audit.emit({
        tenantId: principal.tenantId,
        layer: "audit",
        actor: principal.id,
        action: "audit.export.enqueued",
        inputs: { format: body.format, since: body.since ?? null, until: body.until ?? null },
        outputs: { job_id: jobId },
      });
      reply.status(202);
      return { job_id: jobId, format: body.format, status: "enqueued" };
    },
  );

  // GET /audit/anchor/latest
  app.get("/audit/anchor/latest", async (request, reply) => {
    const principal = requirePrincipal(request);
    requireScope(principal.scopes, READ);
    const anchor = await withTenantScope(deps.pool, principal.tenantId, (c) => findLatestAnchor(c));
    if (anchor === null) {
      throw brainError("audit_anchor_not_yet_published", "no anchor published yet");
    }
    reply.status(200);
    return {
      id: anchor.id,
      merkle_root: anchor.merkle_root.toString("hex"),
      event_count: anchor.event_count,
      period_start: anchor.period_start.toISOString(),
      period_end: anchor.period_end.toISOString(),
      onchain_tx_hash: anchor.onchain_tx_hash?.toString("hex") ?? null,
      onchain_block_number: anchor.onchain_block_number,
    };
  });

  // GET /audit/verify — PUBLIC (skipAuth) — pure inclusion verifier.
  // Clients supply root + leaf + proof; we return ok:true if it verifies.
  // No DB access. §3.1 public endpoint.
  app.get(
    "/audit/verify",
    {
      config: { skipAuth: true },
      schema: {
        querystring: {
          type: "object",
          required: ["root", "leaf", "proof"],
          properties: {
            root: { type: "string", pattern: "^[0-9a-fA-F]{64}$" },
            leaf: { type: "string", pattern: "^[0-9a-fA-F]{64}$" },
            proof: { type: "string", description: "comma-separated hex siblings" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Querystring: { root: string; leaf: string; proof: string } }>,
      reply,
    ) => {
      const root = Buffer.from(request.query.root, "hex");
      const leaf = Buffer.from(request.query.leaf, "hex");
      const proof = request.query.proof
        .split(",")
        .filter((s) => s.length > 0)
        .map((s) => Buffer.from(s, "hex"));
      const ok = verifyProof(root, leaf, proof);
      reply.status(200);
      return { ok };
    },
  );

  // -------------------------------------------------------------------------
  // Outbound webhook endpoint management
  // POST /audit/webhooks/endpoints    — register a new endpoint (returns secret once)
  // GET  /audit/webhooks/endpoints    — list endpoints (secret masked)
  // DELETE /audit/webhooks/endpoints/:id — remove an endpoint
  // -------------------------------------------------------------------------

  app.post(
    "/audit/webhooks/endpoints",
    async (
      request: FastifyRequest<{
        Body: { url?: string; enabled_events?: string[] };
      }>,
      reply,
    ) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, WRITE);
      const { url, enabled_events } = request.body ?? {};
      if (typeof url !== "string" || !url.startsWith("https://")) {
        throw brainError("request_body_invalid", "url must be an https:// string");
      }
      if (
        enabled_events !== undefined &&
        (!Array.isArray(enabled_events) || enabled_events.some((e) => !FORWARDED_EVENTS.has(e)))
      ) {
        throw brainError(
          "request_body_invalid",
          "enabled_events must be a subset of forwarded event types",
          {
            details: { allowed: [...FORWARDED_EVENTS] },
          },
        );
      }
      const secret = generateWebhookSecret();
      const id = newWebhookEndpointId();
      const row = await withTenantScope(deps.pool, principal.tenantId, (c) =>
        insertWebhookEndpoint(c, {
          id,
          tenant_id: principal.tenantId,
          url,
          secret,
          enabled_events: enabled_events ?? null,
        }),
      );
      reply.status(201);
      // Secret returned only on creation.
      return {
        id: row.id,
        url: row.url,
        enabled_events: row.enabled_events,
        enabled: row.enabled,
        secret,
        created_at: row.created_at.toISOString(),
      };
    },
  );

  app.get("/audit/webhooks/endpoints", async (request: FastifyRequest, reply) => {
    const principal = requirePrincipal(request);
    requireScope(principal.scopes, READ);
    const rows = await withTenantScope(deps.pool, principal.tenantId, (c) =>
      listWebhookEndpoints(c),
    );
    reply.status(200);
    return {
      endpoints: rows.map((r) => ({
        id: r.id,
        url: r.url,
        enabled_events: r.enabled_events,
        enabled: r.enabled,
        secret_preview: `${r.secret.slice(0, 8)}...`,
        created_at: r.created_at.toISOString(),
      })),
    };
  });

  app.delete(
    "/audit/webhooks/endpoints/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, WRITE);
      const deleted = await withTenantScope(deps.pool, principal.tenantId, (c) =>
        deleteWebhookEndpoint(c, request.params.id),
      );
      if (!deleted) {
        throw brainError("audit_event_not_found", "webhook endpoint not found");
      }
      reply.status(204);
    },
  );
}

function requirePrincipal(request: FastifyRequest) {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  return request.principal;
}

function serializeEvent(row: AuditEventRow): Record<string, unknown> {
  return {
    id: row.id,
    layer: row.layer,
    actor: row.actor,
    action: row.action,
    inputs: row.inputs,
    outputs: row.outputs,
    policy_version: row.policy_version,
    event_hash: row.event_hash.toString("hex"),
    prev_event_hash: row.prev_event_hash?.toString("hex") ?? null,
    created_at: row.created_at.toISOString(),
  };
}
