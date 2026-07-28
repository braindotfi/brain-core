/**
 * The `auth` service (Phase 1): `auth.brain.fi`'s OAuth 2.0 authorization
 * server. This phase serves discovery only (RFC 8414 metadata and JWKS), plus
 * interim `/authorize` and `/token` stubs so a client that already discovered
 * these endpoints (services/api/src/main.ts:1805 advertises `AUTH_ISSUER`
 * today) fails cleanly instead of hitting a bare 404. Phase 2a replaces both
 * stubs with the real authorization-code + PKCE flow.
 *
 * No DB, no Redis, no session cookie, no consent UI in this phase.
 */

import Fastify, { type FastifyInstance } from "fastify";
import fastifyHelmet from "@fastify/helmet";
import {
  buildAuthorizationServerMetadata,
  WELL_KNOWN_AS_PATH,
  WELL_KNOWN_JWKS_PATH,
} from "./metadata.js";
import { buildJwks } from "./jwks.js";

export interface BuildAuthAppOptions {
  /** `AUTH_ISSUER`, the sole source of `issuer` and the derived `jwks_uri`. Never `AUTH_JWKS_URL`. */
  readonly issuer: string;
  /** `AUTH_SIGN_KEY`, the private signing JWK JSON string. */
  readonly signKey: string;
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly commit: string;
  /** Fastify logger option. Defaults to `true` (pino, matching services/api). */
  readonly logger?: boolean;
}

/**
 * Error body for the interim `/authorize` and `/token` stubs.
 *
 * `temporarily_unavailable` is formally registered for the authorization
 * endpoint (RFC 6749 section 4.1.2.1), not the token endpoint's section 5.2
 * error set. It is reused deliberately for the `/token` stub too: none of
 * section 5.2's codes (invalid_request, invalid_client, invalid_grant,
 * unauthorized_client, unsupported_grant_type, invalid_scope) describe "this
 * endpoint exists but Phase 2a has not shipped yet" without misdescribing the
 * request itself as malformed. Do not correct this to invalid_request.
 */
const TEMPORARILY_UNAVAILABLE = { error: "temporarily_unavailable" } as const;

export async function buildAuthApp(opts: BuildAuthAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true, disableRequestLogging: false });

  // registerSecurityHeaders (services/api/src/security-headers.ts) is not
  // importable here without depending on @brain/api, which is not exported as
  // a workspace package for reuse (only "." is in its package.json "exports",
  // and that export carries the whole API's boot). Phase 1 serves JSON only,
  // no HTML, no cookies, no forms, so @fastify/helmet's defaults are enough;
  // the full CSP-with-nonces treatment matters starting Phase 2a's consent
  // page and should be revisited then.
  await app.register(fastifyHelmet);

  const metadata = buildAuthorizationServerMetadata(opts.issuer);
  const { jwks } = buildJwks(opts.signKey);

  app.get("/healthz", async () => ({
    ok: true,
    service: opts.serviceName,
    version: opts.serviceVersion,
    commit: opts.commit,
  }));

  app.get(WELL_KNOWN_AS_PATH, async () => metadata);

  app.get(WELL_KNOWN_JWKS_PATH, async (_req, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return jwks;
  });

  app.get("/authorize", async (_req, reply) => {
    reply.code(503);
    return TEMPORARILY_UNAVAILABLE;
  });

  app.post("/token", async (_req, reply) => {
    // RFC 6749 section 5.1 requires no-store on token-endpoint responses.
    reply.header("cache-control", "no-store").code(503);
    return TEMPORARILY_UNAVAILABLE;
  });

  return app;
}
