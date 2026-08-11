/**
 * Audit routes: 5 core endpoints + 3 webhook endpoint management routes.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  newWebhookEndpointId,
  parseDateParam,
  parsePositiveIntParam,
  requireScope,
  withTenantScope,
  type Scope,
} from "@brain/shared";
import { FORWARDED_EVENTS, generateWebhookSecret } from "@brain/shared";
import { nextAnchorWindow } from "./anchorWindow.js";
import { buildTree, makeProof, verifyProof } from "./merkle.js";
import { publishAnchor } from "./publisher.js";
import {
  findAnchorForEvent,
  findAuditAnchoringMode,
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
      // Malformed limit/since/until is the caller's error: reject with 400
      // request_params_invalid instead of letting NaN / Invalid Date reach SQL
      // and surface as a misleading 500 (Fable-5 F-2).
      const limit = parsePositiveIntParam("limit", request.query.limit, {
        fallback: 100,
        max: 500,
      });
      const since = parseDateParam("since", request.query.since);
      const until = parseDateParam("until", request.query.until);
      const rows = await withTenantScope(deps.pool, principal.tenantId, (c) =>
        queryEvents(c, {
          ...(request.query.layer !== undefined ? { layer: request.query.layer } : {}),
          ...(since !== undefined ? { since } : {}),
          ...(until !== undefined ? { until } : {}),
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
        // The anchor whose window CONTAINS this event, not just the newest
        // anchor -- an event outside the newest window was still on-chain,
        // just under an older window, and deserves a real proof.
        const anchor = await findAnchorForEvent(c, event.created_at);
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

      // `|| 200` caught NaN here but not a negative — `?limit=-5` still reached
      // SQL as LIMIT -5 and 500ed. Same strict parse as /audit/events (F-2).
      const limit = parsePositiveIntParam("limit", request.query.limit, {
        fallback: 200,
        max: 500,
      });

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

  // POST /audit/export — declared stub. There is no job row, no worker, and
  // no status/download route behind this endpoint, so a previous 202 handed
  // callers a job_id that could never be redeemed. Fail fast instead of
  // pretending: validate the request shape (still a real 400), then refuse
  // with 501 pointing at the real, working export at
  // POST /v1/tenants/{tenant_id}/export (status + download routes included).
  app.post(
    "/audit/export",
    async (
      request: FastifyRequest<{
        Body: { format?: "jsonl" | "csv"; since?: string; until?: string };
      }>,
    ) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, READ);
      const body = request.body ?? {};
      if (body.format !== "jsonl" && body.format !== "csv") {
        throw brainError("request_body_invalid", "format must be jsonl or csv");
      }
      throw brainError(
        "dependency_unavailable",
        "audit export is not implemented; use POST /v1/tenants/{tenant_id}/export",
        { statusOverride: 501 },
      );
    },
  );

  // GET /audit/anchor/latest
  app.get("/audit/anchor/latest", async (request, reply) => {
    const principal = requirePrincipal(request);
    requireScope(principal.scopes, READ);
    const result = await withTenantScope(deps.pool, principal.tenantId, async (c) => ({
      mode: await findAuditAnchoringMode(c),
      anchor: await findLatestAnchor(c),
    }));
    if (result.mode === "db_only") {
      reply.status(200);
      return {
        anchoring_mode: "db_only",
        guarantee: "database_hash_chain",
        id: null,
        merkle_root: null,
        event_count: null,
        period_start: null,
        period_end: null,
        onchain_tx_hash: null,
        onchain_block_number: null,
      };
    }
    const anchor = result.anchor;
    if (anchor === null) {
      throw brainError("audit_anchor_not_yet_published", "no anchor published yet");
    }
    reply.status(200);
    return {
      anchoring_mode: "onchain",
      guarantee: "base_sepolia",
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

    app.post("/audit/anchor/publish", async (request, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, "audit:admin" as Scope);

      const anchoringMode = await withTenantScope(deps.pool, principal.tenantId, (c) =>
        findAuditAnchoringMode(c),
      );
      if (anchoringMode === "db_only") {
        throw brainError(
          "audit_anchor_db_only",
          "this tenant retains a database hash chain and is not eligible for on-chain anchoring",
          { statusOverride: 409 },
        );
      }

      // The anchor row itself is the durable cooldown source, not in-process
      // state. An in-process Map resets on every restart (bypassable across a
      // deploy) and is per-replica, and it also had a bug where a FAILED
      // publish still consumed the cooldown because the Map was set BEFORE
      // the broadcast. This endpoint spends real ETH (the anchor key drains
      // fast), so the guard has to survive a restart. withTenantScope is used
      // deliberately: RLS scopes `max(created_at)` to this tenant's own
      // anchors, so one tenant can never read or be throttled by another
      // tenant's publish history.
      const lastAnchorAt = await withTenantScope(deps.pool, principal.tenantId, async (c) => {
        const { rows } = await c.query<{ last_at: Date | null }>(
          `SELECT max(created_at) AS last_at FROM audit_anchors`,
        );
        return rows[0]?.last_at ?? null;
      });
      if (lastAnchorAt !== null) {
        const msUntilReady = lastAnchorAt.getTime() + PUBLISH_COOLDOWN_MS - Date.now();
        if (msUntilReady > 0) {
          throw brainError(
            "rate_limited",
            `anchor cooling down — retry in ${Math.ceil(msUntilReady / 1000)}s`,
            { details: { retry_after_seconds: Math.ceil(msUntilReady / 1000) } },
          );
        }
      }

      const now = new Date();
      // Derive the window the same way the scheduled cross-tenant publisher
      // does (nextAnchorWindow) instead of a fixed [now-24h, now] lookback --
      // a fixed window silently orphans everything older than 24h the first
      // time an operator triggers this endpoint for a backlogged tenant.
      const coverage = await withTenantScope(deps.pool, principal.tenantId, async (c) => {
        const { rows } = await c.query<{ covered_to: Date | null; oldest_unanchored: Date | null }>(
          `WITH cov AS (
             SELECT MAX(period_end) AS covered_to
               FROM audit_anchors
              WHERE onchain_status <> 'reverted'
           )
           SELECT cov.covered_to,
                  (SELECT MIN(created_at) FROM audit_events
                     WHERE cov.covered_to IS NULL OR created_at > cov.covered_to) AS oldest_unanchored
             FROM cov`,
        );
        return rows[0] ?? { covered_to: null, oldest_unanchored: null };
      });
      const { periodStart, periodEnd } = nextAnchorWindow(
        coverage.covered_to,
        // No unanchored events at all collapses to a zero-length window, so
        // publishAnchor's existing "no events" path fires below.
        coverage.oldest_unanchored ?? now,
        now,
      );
      const anchor = await publishAnchor(deps.pool, broadcaster, {
        tenantId: principal.tenantId,
        periodStart,
        periodEnd,
      });
      if (anchor === null) {
        throw brainError("audit_no_events", "no unanchored audit events to publish");
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
  const eventType = row.event_type ?? "system_activity";
  return {
    id: row.id,
    layer: row.layer,
    event_type: eventType,
    category: eventType,
    severity: row.severity ?? (eventType === "flagged" ? "warning" : "info"),
    actor: row.actor,
    actor_ref: serializeActorRef(row),
    action: row.action,
    inputs: row.inputs,
    outputs: row.outputs,
    policy_version: row.policy_version,
    policy_decision_id: row.policy_decision_id,
    policy_check_id: row.policy_check_id,
    outcome: row.outcome,
    event_hash: row.event_hash.toString("hex"),
    prev_event_hash: row.prev_event_hash?.toString("hex") ?? null,
    created_at: row.created_at.toISOString(),
  };
}

function serializeActorRef(row: AuditEventRow): Record<string, unknown> {
  const type = inferActorType(row.actor);
  return {
    id: row.actor,
    type,
    display_name: row.actor_display_name ?? null,
    email: row.actor_email ?? null,
    lookup: actorLookupPath(type, row.actor),
  };
}

function inferActorType(actor: string): string {
  if (actor.startsWith("user_")) return "user";
  if (actor.startsWith("agent_")) return "agent";
  if (actor.startsWith("partner_")) return "partner";
  if (actor.startsWith("key_") || actor.startsWith("ak_")) return "api_key";
  if (actor === "system" || actor.startsWith("system_") || actor.endsWith("_worker")) {
    return "system";
  }
  return "unknown";
}

function actorLookupPath(type: string, actor: string): string | null {
  if (type === "user") return `/v1/members/${encodeURIComponent(actor)}`;
  if (type === "agent") return `/v1/execution/agents/${encodeURIComponent(actor)}`;
  return null;
}
