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
import { publishAnchor } from "./publisher.js";
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
        let anchorTxHash: string | null = null;
        let anchorBlock: number | null = null;
        if (anchor !== null) {
          const events = await listEventsForAnchor(c, anchor.period_start, anchor.period_end);
          const idx = events.findIndex((e) => e.id === event.id);
          if (idx !== -1) {
            const tree = buildTree(events.map((e) => e.event_hash));
            proofHex = makeProof(tree, idx).map((b) => b.toString("hex"));
            rootHex = tree.root.toString("hex");
            anchorTxHash = anchor.onchain_tx_hash?.toString("hex") ?? null;
            anchorBlock =
              anchor.onchain_block_number !== null ? Number(anchor.onchain_block_number) : null;
          }
        }
        return { event, proof: proofHex, root: rootHex, anchorTxHash, anchorBlock };
      });
      if (result === null) {
        throw brainError("audit_event_not_found", "no such audit event");
      }
      reply.status(200);
      // §audit/event contract: a single nested inclusion_proof object.
      return {
        event: serializeEvent(result.event),
        inclusion_proof: {
          merkle_root: result.root,
          merkle_proof: result.proof,
          anchor_tx_hash: result.anchorTxHash,
          anchor_block: result.anchorBlock,
        },
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

  // POST /audit/anchor/publish — on-demand anchor (demo presenter trigger).
  // Only registered when a broadcaster is wired in.
  if (deps.broadcaster !== undefined) {
    const broadcaster = deps.broadcaster;
    // Per-tenant cooldown to prevent rapid re-anchoring and runaway on-chain spend.
    const PUBLISH_COOLDOWN_MS = 60_000;
    const lastPublishTime = new Map<string, number>();

    app.post("/audit/anchor/publish", async (request, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, "audit:admin" as Scope);

      const lastRun = lastPublishTime.get(principal.tenantId) ?? 0;
      const msUntilReady = lastRun + PUBLISH_COOLDOWN_MS - Date.now();
      if (msUntilReady > 0) {
        throw brainError(
          "rate_limited",
          `anchor cooling down — retry in ${Math.ceil(msUntilReady / 1000)}s`,
          { details: { retry_after_seconds: Math.ceil(msUntilReady / 1000) } },
        );
      }
      lastPublishTime.set(principal.tenantId, Date.now());

      const now = new Date();
      const periodStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const anchor = await publishAnchor(deps.pool, broadcaster, {
        tenantId: principal.tenantId,
        periodStart,
        periodEnd: now,
      });
      if (anchor === null) {
        throw brainError("audit_no_events", "no audit events in the last 24 hours");
      }
      reply.status(200);
      const txHashHex = anchor.onchain_tx_hash?.toString("hex") ?? null;
      return {
        id: anchor.id,
        merkle_root: anchor.merkle_root.toString("hex"),
        event_count: anchor.event_count,
        tx_hash: txHashHex,
        basescan_url: txHashHex !== null ? `https://sepolia.basescan.org/tx/0x${txHashHex}` : null,
      };
    });
  }

  // POST /audit/verify — PUBLIC (skipAuth) — pure inclusion verifier, matching
  // the OpenAPI verifyInclusion contract. Caller supplies event_hash + a Merkle
  // proof + the claimed merkle_root; we return whether the proof verifies. The
  // on-chain presence half of the contract requires an RPC the §3.1 "pure
  // function" endpoint does not make, so onchain_block is null here (a future
  // RPC-backed lookup can populate it). No DB access.
  app.post(
    "/audit/verify",
    {
      config: { skipAuth: true },
      schema: {
        body: {
          type: "object",
          required: ["event_hash", "merkle_proof", "merkle_root"],
          properties: {
            event_hash: { type: "string", pattern: "^[0-9a-fA-F]{64}$" },
            merkle_root: { type: "string", pattern: "^[0-9a-fA-F]{64}$" },
            merkle_proof: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Body: { event_hash: string; merkle_proof: string[]; merkle_root: string };
      }>,
      reply,
    ) => {
      const body = request.body;
      const root = Buffer.from(body.merkle_root, "hex");
      const leaf = Buffer.from(body.event_hash, "hex");
      const proof = body.merkle_proof.filter((s) => s.length > 0).map((s) => Buffer.from(s, "hex"));
      const verified = verifyProof(root, leaf, proof);
      reply.status(200);
      return { verified, onchain_block: null };
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
