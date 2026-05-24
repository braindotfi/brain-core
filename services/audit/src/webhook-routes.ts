/**
 * H-20 webhook dead-letter + replay routes.
 *
 *   GET  /v1/webhooks/{endpoint_id}/dead-letters — list undeliverable events.
 *   POST /v1/webhooks/{endpoint_id}/replay       — re-deliver replayable ones.
 *
 * Tenant-isolated via withTenantScope/RLS. Replay re-delivers each dead-letter
 * still under MAX_WEBHOOK_DELIVERY_ATTEMPTS; a success clears the row, a failure
 * bumps attempt_count (and once it reaches the cap the row is exhausted and ops
 * must intervene). The replay route is the ops surface that replaces the old
 * silent retry behavior.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  deliverWebhook,
  getReplayableDeadLetters,
  incrementDeadLetterAttempt,
  deleteDeadLetterById,
  listDeadLetters,
  requireScope,
  withTenantScope,
  type Scope,
} from "@brain/shared";
import type { Pool } from "pg";
import { findWebhookEndpoint } from "./webhooks.js";

const READ: Scope = "audit:read";
const WRITE: Scope = "audit:write";

export interface WebhookRouteDeps {
  pool: Pool;
  /** Delivery fn (defaults to the real signed POST); injectable for tests. */
  deliver?: (
    endpoint: { url: string; secret: string },
    payload: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}

function requirePrincipal(request: FastifyRequest) {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  return request.principal;
}

export async function registerWebhookRoutes(
  app: FastifyInstance,
  deps: WebhookRouteDeps,
): Promise<void> {
  // GET /webhooks/:endpoint_id/dead-letters
  app.get(
    "/webhooks/:endpoint_id/dead-letters",
    async (request: FastifyRequest<{ Params: { endpoint_id: string } }>, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, READ);
      const endpointId = request.params.endpoint_id;
      const result = await withTenantScope(deps.pool, principal.tenantId, async (c) => {
        const endpoint = await findWebhookEndpoint(c, endpointId);
        if (endpoint === null) return null;
        return listDeadLetters(c, endpointId);
      });
      if (result === null) {
        throw brainError("audit_event_not_found", "no such webhook endpoint");
      }
      reply.status(200);
      return {
        endpoint_id: endpointId,
        dead_letters: result.map((d) => ({
          id: d.id,
          event_id: d.event_id,
          event_type: d.event_type,
          last_error: d.last_error,
          attempt_count: d.attempt_count,
          created_at:
            d.created_at instanceof Date ? d.created_at.toISOString() : String(d.created_at),
          last_attempt_at:
            d.last_attempt_at instanceof Date
              ? d.last_attempt_at.toISOString()
              : String(d.last_attempt_at),
        })),
      };
    },
  );

  // POST /webhooks/:endpoint_id/replay — idempotent (re-running is safe).
  app.post(
    "/webhooks/:endpoint_id/replay",
    { config: { idempotent: true } },
    async (request: FastifyRequest<{ Params: { endpoint_id: string } }>, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, WRITE);
      const endpointId = request.params.endpoint_id;

      const result = await withTenantScope(deps.pool, principal.tenantId, async (c) => {
        const endpoint = await findWebhookEndpoint(c, endpointId);
        if (endpoint === null) return null;
        const replayable = await getReplayableDeadLetters(c, endpointId);
        const deliver = deps.deliver ?? deliverWebhook;
        let redelivered = 0;
        let stillFailing = 0;
        for (const dl of replayable) {
          const outcome = await deliver(
            { url: endpoint.url, secret: endpoint.secret },
            JSON.stringify(dl.payload),
          );
          if (outcome.ok) {
            await deleteDeadLetterById(c, dl.id);
            redelivered += 1;
          } else {
            await incrementDeadLetterAttempt(c, dl.id, outcome.error ?? "delivery failed");
            stillFailing += 1;
          }
        }
        return { attempted: replayable.length, redelivered, still_failing: stillFailing };
      });

      if (result === null) {
        throw brainError("audit_event_not_found", "no such webhook endpoint");
      }
      reply.status(200);
      return { endpoint_id: endpointId, ...result };
    },
  );
}
