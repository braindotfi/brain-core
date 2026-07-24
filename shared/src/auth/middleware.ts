/**
 * Brain JWT auth plugin (Fastify).
 *
 * Terminates the bearer-token protocol at the edge. On success, the request
 * gets `request.principal` populated. On failure, a §4.1 error envelope is
 * returned with an appropriate 401/403 status.
 *
 * Exemption list (§3.1):
 *   - POST /raw/webhooks/{provider}  (HMAC-signed, not bearer)
 *   - GET  /audit/verify             (public, pure function)
 *   - GET  /health                   (root health check)
 *
 * Exemptions are registered by adding `skipAuth: true` to the route config.
 * The plugin trusts that flag rather than maintaining a URL allowlist —
 * route ownership stays with the route author.
 */

import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { AuditEmitter } from "../audit/emitter.js";
import { brainError } from "../errors.js";
import { currentRequestHasApiKeyAuditEvent, enterApiKeyId } from "../correlation.js";
import type { JwtVerifier } from "./jwt.js";
import type { Principal } from "./principal.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Present iff the route is non-exempt and auth succeeded. */
    principal?: Principal;
    /** Present iff a first-class Brain API key authenticated the request. */
    apiKeyId?: string;
  }
  interface FastifyContextConfig {
    /** Set `skipAuth: true` on a route config to bypass JWT verification. */
    skipAuth?: boolean;
  }
}

export interface AuthPluginOptions {
  verifier: JwtVerifier;
  apiKeyAuthenticator?: (secret: string) => Promise<{ principal: Principal; keyId: string } | null>;
  apiKeyUsageAudit?: AuditEmitter;
}

const AUTH_HEADER_RE = /^Bearer\s+(.+)$/i;

export function extractBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = AUTH_HEADER_RE.exec(header.trim());
  return match !== null && match[1] !== undefined ? match[1].trim() : null;
}

const plugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, opts) => {
  const { verifier, apiKeyAuthenticator, apiKeyUsageAudit } = opts;

  fastify.addHook("onRequest", async (request: FastifyRequest) => {
    if (request.routeOptions.config?.skipAuth === true) {
      return;
    }
    const token = extractBearer(request.headers.authorization);
    if (token === null) {
      throw brainError("auth_token_missing", "missing bearer token");
    }
    if (token.startsWith("brain_sk_")) {
      const apiKeyAuth = await apiKeyAuthenticator?.(token);
      if (apiKeyAuth === undefined || apiKeyAuth === null) {
        throw brainError("auth_invalid_key", "api key invalid");
      }
      request.principal = apiKeyAuth.principal;
      request.apiKeyId = apiKeyAuth.keyId;
      enterApiKeyId(apiKeyAuth.keyId);
      return;
    }
    const principal = await verifier.verify(token);
    request.principal = principal;
  });

  fastify.addHook("onResponse", async (request, reply) => {
    if (
      apiKeyUsageAudit === undefined ||
      request.apiKeyId === undefined ||
      request.principal === undefined ||
      reply.statusCode < 200 ||
      reply.statusCode >= 400 ||
      currentRequestHasApiKeyAuditEvent()
    ) {
      return;
    }

    try {
      await apiKeyUsageAudit.emit({
        tenantId: request.principal.tenantId,
        // Pass keyId explicitly rather than relying solely on
        // CorrelatingAuditEmitter pulling it from AsyncLocalStorage, the
        // request object already has it right here (checked above), so this
        // path no longer depends on ALS context surviving the hook chain.
        keyId: request.apiKeyId,
        layer: "audit",
        actor: request.principal.id,
        action: "http.request",
        inputs: {
          method: request.method,
          route: routePattern(request),
        },
        outputs: {
          status_code: reply.statusCode,
        },
      });
    } catch (err) {
      request.log.warn({ err }, "api key usage audit emit failed");
    }
  });
};

function routePattern(request: FastifyRequest): string {
  return request.routeOptions.url ?? "unknown";
}

export default fp(plugin, { name: "brain-auth", fastify: "5.x" });
