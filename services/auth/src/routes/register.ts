/**
 * `POST /register` (RFC 7591 Dynamic Client Registration, Phase 3).
 *
 * Deliberately a sibling file, not appended to routes/oauth.ts: that file is
 * already ~1100 lines covering /authorize, /authorize/consent, /token, and
 * /revoke, and DCR is a single, self-contained handler with no shared state
 * or helpers to justify inlining it there.
 *
 * Open and unauthenticated by design (OAUTH-AS-PLAN.md section 3) -- an MCP
 * host discovers this AS and registers with zero prior knowledge, so there is
 * no tenant, no client_id, and no credential to gate this endpoint on. Rate
 * limited per IP instead, since (unlike /token) there is no client_id to key
 * a limiter on until AFTER a registration succeeds. Real per-client-IP
 * behavior for this limit depends on server.ts's `trustProxy: 1` (Opus
 * review, Phase 3 follow-up) -- see that file's header for why `true` was
 * wrong.
 *
 * The handler is thin: all validation lives in client-registration.ts (pure,
 * DB-free, unit-tested there). This file only wires that result to the
 * database insert and the RFC 7591 section 3.2.1 response shape.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { validateClientRegistration } from "../client-registration.js";
import { registerOauthClient } from "../oauth-clients.js";

export interface RegisterRouteDeps {
  readonly authPool: Pool;
}

/**
 * 5/min per IP (OAUTH-AS-PLAN.md section 5.10, the non-negotiable security
 * requirements list -- NOT section 3's looser "Open DCR, rate limited" note,
 * which only names the endpoint). Exported so the rate-limit test asserts
 * against this constant rather than a duplicated literal.
 */
export const REGISTER_RATE_LIMIT = { max: 5, timeWindow: "1 minute" } as const;

function isJsonContentType(contentType: string | undefined): boolean {
  return contentType !== undefined && contentType.toLowerCase().startsWith("application/json");
}

export async function registerClientRegistrationRoute(
  app: FastifyInstance,
  deps: RegisterRouteDeps,
): Promise<void> {
  app.post(
    "/register",
    { config: { rateLimit: REGISTER_RATE_LIMIT } },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      reply.header("cache-control", "no-store");

      // RFC 7591 section 3.1 requires a JSON request body. server.ts
      // registers an application/x-www-form-urlencoded content-type parser
      // server-wide (needed for /login, /authorize/consent's real <form>
      // submits), so without this check a plain <form method="post"
      // action="/register"> on ANY web page would successfully register a
      // client from a visitor's browser: a form POST is a CORS simple
      // request (no preflight), so it is distributed across every visitor's
      // own IP and cannot be stopped by this endpoint's own per-IP rate
      // limit (Opus review, Phase 3 follow-up).
      if (!isJsonContentType(request.headers["content-type"])) {
        reply.code(400);
        return {
          error: "invalid_client_metadata",
          error_description: "Content-Type must be application/json.",
        };
      }

      const result = validateClientRegistration(request.body);
      if (!result.ok) {
        reply.code(400);
        return result.error;
      }
      const { value } = result;

      let registered: { clientId: string; createdAt: Date };
      try {
        registered = await registerOauthClient(deps.authPool, value);
      } catch (err) {
        // Never let a raw DB error (e.g. "permission denied for table
        // oauth_clients" against a misconfigured brain_auth grant) reach an
        // unauthenticated caller -- Fastify's default error handler would
        // otherwise serialize err.message verbatim, in a body with no
        // `error` field at all (Opus review, Phase 3 follow-up). Log the
        // real cause server-side; the caller gets a generic, RFC-shaped
        // error. `server_error` is not one of RFC 7591 section 3.2.2's
        // client-error codes (this is a 500, not a 400), but it matches the
        // same code RFC 6749 section 4.1.2.1 defines for the authorization
        // endpoint's own server-side failure case, and no OAuth error
        // vocabulary in this codebase defines anything more specific.
        request.log.error({ event: "oauth.client.registration_failed", err });
        reply.code(500);
        return { error: "server_error", error_description: "Client registration failed." };
      }

      // deps.audit.emit requires a tenantId, and this registration happens
      // before any tenant is known -- the same not-tenant-scoped reasoning as
      // oauth_clients' migration 0001 comment. A structured log line is the
      // record instead of an audit event; a registered client carries zero
      // authority until a tenant admin consents at /authorize, so there is
      // nothing yet worth an audit trail beyond "this row was created."
      request.log.info({
        event: "oauth.client.registered",
        client_id: registered.clientId,
        client_name: value.clientName,
        redirect_uris: value.redirectUris,
        grant_types: value.grantTypes,
      });

      // RFC 7591 section 3.2.1. No client_secret, no client_secret_expires_at
      // -- public clients only. Deliberately no RFC 7592 fields either
      // (registration_access_token, registration_client_uri): not built,
      // see client-registration.ts's header.
      reply.code(201);
      return {
        client_id: registered.clientId,
        client_id_issued_at: Math.floor(registered.createdAt.getTime() / 1000),
        redirect_uris: value.redirectUris,
        grant_types: value.grantTypes,
        response_types: value.responseTypes,
        token_endpoint_auth_method: value.tokenEndpointAuthMethod,
        client_name: value.clientName,
        ...(value.softwareId !== undefined ? { software_id: value.softwareId } : {}),
        ...(value.softwareVersion !== undefined ? { software_version: value.softwareVersion } : {}),
      };
    },
  );
}
