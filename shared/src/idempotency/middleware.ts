/**
 * Brain idempotency plugin (Fastify).
 *
 * §5.1:
 *   - Every write endpoint is either naturally idempotent or accepts an
 *     `Idempotency-Key` header.
 *   - Keys are tenant-scoped with a 24h TTL in Redis.
 *   - Matching completed request → return the stored response.
 *   - Matching in-flight request → 409.
 *   - Same key + DIFFERENT body → 409 execution_idempotency_conflict.
 *
 * Endpoints opt in by adding `idempotent: true` to the route config. The
 * plugin runs on preHandler to probe the store; if `done`, it replies
 * immediately; if `miss`, it lets the handler run and then persists the
 * response on-send.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { brainError } from "../errors.js";
import type { IdempotencyStore } from "./store.js";
import { hashBody } from "./store.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Set `idempotent: true` to enable Idempotency-Key support on the route. */
    idempotent?: boolean;
  }
  interface FastifyRequest {
    /** The Idempotency-Key header, if supplied on an `idempotent` route. */
    idempotencyKey?: string;
    /** The body hash computed for idempotency. Reused by on-send. */
    idempotencyBodyHash?: string;
  }
}

export interface IdempotencyPluginOptions {
  store: IdempotencyStore;
  ttlSeconds: number;
}

const HEADER_NAME = "idempotency-key";
const MAX_KEY_LEN = 256;

const plugin: FastifyPluginAsync<IdempotencyPluginOptions> = async (fastify, opts) => {
  const { store, ttlSeconds } = opts;

  fastify.addHook("preHandler", async (request, reply) => {
    if (request.routeOptions.config?.idempotent !== true) return;

    const rawKey = request.headers[HEADER_NAME];
    if (rawKey === undefined) return; // Naturally-idempotent endpoints may omit the key.
    if (typeof rawKey !== "string" || rawKey.length === 0 || rawKey.length > MAX_KEY_LEN) {
      throw brainError("request_params_invalid", "malformed Idempotency-Key header");
    }
    const principal = request.principal;
    if (principal === undefined) {
      // Should never happen — auth runs before idempotency in hook order.
      throw brainError("auth_token_missing", "principal required for idempotent write");
    }

    const bodyStr = serializeBody(request.body);
    const bodyHash = hashBody(bodyStr);
    request.idempotencyKey = rawKey;
    request.idempotencyBodyHash = bodyHash;

    const probe = await store.probeAndMark({
      tenantId: principal.tenantId,
      key: rawKey,
      bodyHash,
      ttlSeconds,
    });

    switch (probe.state) {
      case "miss":
        return;
      case "in_flight":
        throw brainError(
          "execution_idempotency_conflict",
          "a concurrent request with this Idempotency-Key is still in flight",
          { statusOverride: 409 },
        );
      case "conflict":
        throw brainError(
          "execution_idempotency_conflict",
          "Idempotency-Key reused with a different request body",
          {
            statusOverride: 409,
            details: {
              stored_body_hash: probe.storedBodyHash,
              supplied_body_hash: probe.suppliedBodyHash,
            },
          },
        );
      case "done":
        reply.status(probe.response.status);
        reply.header("content-type", "application/json");
        reply.header("idempotent-replay", "true");
        return reply.send(probe.response.body);
    }
  });

  fastify.addHook("onSend", async (request, reply, payload) => {
    if (request.idempotencyKey === undefined) return payload;
    if (request.idempotencyBodyHash === undefined) return payload;
    // Don't persist error responses — the caller should be able to retry with
    // the same key and actually get through on a recovered dependency. §5.1
    // only prescribes storing completed responses.
    if (reply.statusCode >= 400) {
      await store.discard({
        tenantId: request.principal?.tenantId ?? "_unknown",
        key: request.idempotencyKey,
      });
      return payload;
    }

    const body = coerceToString(payload);
    await store.complete({
      tenantId: request.principal?.tenantId ?? "_unknown",
      key: request.idempotencyKey,
      bodyHash: request.idempotencyBodyHash,
      response: { status: reply.statusCode, body },
      ttlSeconds: ttlSeconds,
    });
    return payload;
  });
};

function serializeBody(body: unknown): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  return JSON.stringify(body);
}

function coerceToString(payload: unknown): string {
  if (payload === undefined || payload === null) return "";
  if (typeof payload === "string") return payload;
  if (Buffer.isBuffer(payload)) return payload.toString("utf8");
  return JSON.stringify(payload);
}

// Unused helper kept internal; re-export via fastify-plugin.
// Exported for caller tests that want to manually trigger the same logic.
export const _internal = { serializeBody, coerceToString };

// Stop eslint/ts complaining about FastifyRequest/FastifyReply unused imports.
export type { FastifyRequest, FastifyReply };

export default fp(plugin, { name: "brain-idempotency", fastify: "5.x" });
