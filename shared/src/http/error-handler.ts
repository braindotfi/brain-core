/**
 * Brain HTTP error handler (Fastify).
 *
 * Maps every error leaving an endpoint into the §4.1 envelope:
 *   { error: { code, message, details?, request_id, docs_url } }
 *
 * Rules:
 *   - BrainError → envelope with its `code` and `statusCode`.
 *   - Fastify validation error → `request_body_invalid` or `request_params_invalid`.
 *   - Fastify 404 ("route not found") → left for the `notFoundHandler` below.
 *   - Everything else → `internal_server_error` (500). Alerting pipeline pages
 *     on any 5xx rate exceedance (§6.4).
 *
 * The handler logs at `error` for 5xx and `warn` for 4xx, per §6.1 level
 * semantics. `request_id` comes from `request.id` (set by the request-id plugin).
 */

import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import {
  BrainError,
  brainError,
  isBrainError,
  toErrorEnvelope,
  type BrainErrorCode,
} from "../errors.js";

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler(async (err, request, reply) => {
    const mapped = mapError(err);
    const envelope = toErrorEnvelope(mapped, request.id ?? "req_unknown");

    const logFn = mapped.statusCode >= 500 ? request.log.error : request.log.warn;
    logFn.call(
      request.log,
      {
        err,
        code: mapped.code,
        status: mapped.statusCode,
        message: mapped.message,
      },
      "request failed",
    );

    reply.status(mapped.statusCode);
    reply.header("content-type", "application/json; charset=utf-8");
    return reply.send(envelope);
  });

  fastify.setNotFoundHandler(async (request, reply) => {
    const err = brainError("wiki_entity_not_found", "route not found", {
      statusOverride: 404,
      details: { path: request.url },
    });
    const envelope = toErrorEnvelope(err, request.id ?? "req_unknown");
    reply.status(404);
    reply.header("content-type", "application/json; charset=utf-8");
    return reply.send(envelope);
  });
};

export function mapError(err: unknown): BrainError {
  if (isBrainError(err)) return err;

  const maybeFastify = err as Partial<FastifyError> & { validation?: unknown };
  if (maybeFastify !== null && maybeFastify !== undefined) {
    // Fastify validation errors carry `.validation` and `.validationContext`.
    if (Array.isArray(maybeFastify.validation)) {
      const code: BrainErrorCode =
        maybeFastify.validationContext === "params"
          ? "request_params_invalid"
          : "request_body_invalid";
      return new BrainError(code, maybeFastify.message ?? "request validation failed", {
        details: { validation: maybeFastify.validation },
      });
    }
    if (maybeFastify.statusCode === 404) {
      return new BrainError("wiki_entity_not_found", maybeFastify.message ?? "not found", {
        statusOverride: 404,
      });
    }
    if (maybeFastify.statusCode === 413) {
      return new BrainError("request_too_large", maybeFastify.message ?? "request too large");
    }
    if (maybeFastify.statusCode === 429) {
      return new BrainError("rate_limit_exceeded", maybeFastify.message ?? "rate limit exceeded");
    }
  }

  // Unknown error — don't leak the message to the client.
  return new BrainError("internal_server_error", "internal server error", {
    cause: err,
  });
}

// Export for test callers that don't want the plugin's onRequest registrations.
export const _forTests = { mapError };

// Keep Fastify types referenced so consumers get the augmented typings.
export type { FastifyRequest, FastifyReply };

export default fp(plugin, { name: "brain-error-handler", fastify: "5.x" });
