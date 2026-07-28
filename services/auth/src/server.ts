/**
 * The `auth` service: `auth.brain.fi`'s OAuth 2.0 authorization server.
 *
 * Phase 1 (unconditional): discovery only -- RFC 8414 metadata and JWKS --
 * plus interim `/authorize` and `/token` stubs so a client that already
 * discovered these endpoints (services/api/src/main.ts:1805 advertises
 * `AUTH_ISSUER` today) fails cleanly instead of hitting a bare 404.
 *
 * Phase 2a increment 2 (when `opts.humanAuth` is provided): adds
 * `GET/POST /login`, `/set-password`, `/forgot-password` -- human
 * authentication at the AS (AUTH-PATHS-PLAN.md section 2, "Path 1").
 *
 * Phase 2a increment 3 (when `opts.oauthCore` is provided): replaces the
 * `/authorize` and `/token` 503 stubs with the real OAuth core -- PKCE,
 * consent, `grant_type=authorization_code` (OAUTH-AS-PLAN.md section 3).
 * Both `opts.humanAuth` and `opts.oauthCore` are optional so Phase 1's
 * discovery-only behavior (and its tests) are unchanged when both are
 * omitted; the 503 stubs remain wired for that mode.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import type { Pool } from "pg";
import type { AuditEmitter } from "@brain/shared";
import {
  buildAuthorizationServerMetadata,
  WELL_KNOWN_AS_PATH,
  WELL_KNOWN_JWKS_PATH,
} from "./metadata.js";
import { buildJwks } from "./jwks.js";
import { registerAuthSecurityHeaders } from "./security-headers.js";
import { registerHumanAuthRoutes } from "./routes/human-auth.js";
import { registerOauthRoutes, type OauthRouteDeps } from "./routes/oauth.js";
import type { UserCredentialReader } from "./credentials.js";

export interface HumanAuthOptions {
  readonly authPool: Pool;
  readonly credentialReader: UserCredentialReader;
  /** `AUTH_COOKIE_SECRET` -- an HMAC secret, never `AUTH_SIGN_KEY`. */
  readonly cookieSecret: string;
  readonly audit: AuditEmitter;
  readonly deliverForgotPasswordEmail: (input: {
    tenantId: string;
    email: string;
    token: string;
    expiresAt: Date;
  }) => Promise<boolean>;
}

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
  /**
   * Test-only: a writable stream for pino to write to instead of its default
   * fd-1 destination. Pino's default destination writes directly to the file
   * descriptor (sonic-boom), bypassing `process.stdout.write` entirely, so
   * overriding that function cannot observe real log output in a test. Unset
   * in production (main.ts never passes it).
   */
  readonly loggerStream?: NodeJS.WritableStream;
  /** Phase 2a increment 2. Omit to keep Phase 1's discovery-only surface. */
  readonly humanAuth?: HumanAuthOptions;
  /** Phase 2a increment 3. Omit to keep the /authorize and /token 503 stubs. */
  readonly oauthCore?: OauthRouteDeps;
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

/**
 * Fastify 5's default `req` serializer emits `{ method, url, version, host,
 * remoteAddress, remotePort }`, and `url` is the full request target
 * INCLUDING the query string. `{ redact: { paths: ["req.query", ...] } }`
 * (the previous approach) does nothing: neither `req.query` nor
 * `req.headers.cookie` exists on that serialized shape, so pino has nothing
 * to redact. Verified live: with that config, `GET /set-password?tid=...&t=
 * <raw token>` wrote the raw token to stdout in the clear (finding 2).
 *
 * This serializer keeps everything the default one does except `url`, which
 * it truncates at the first `?` -- enough for routing/debugging, never the
 * query string a bearer token rides in.
 */
function reqSerializer(request: FastifyRequest): {
  method: string;
  url: string;
  host: string;
  remoteAddress: string;
  remotePort?: number;
} {
  const remotePort: number | undefined = request.socket.remotePort;
  return {
    method: request.method,
    url: request.url.split("?")[0] ?? request.url,
    host: request.hostname,
    remoteAddress: request.ip,
    // exactOptionalPropertyTypes: omit the key entirely rather than assign
    // `undefined` into an optional-but-not-`| undefined` field.
    ...(remotePort !== undefined ? { remotePort } : {}),
  };
}

export async function buildAuthApp(opts: BuildAuthAppOptions): Promise<FastifyInstance> {
  // `logger: false` (server.test.ts) stays exactly `false`. Otherwise strip
  // the query string from every request log line via reqSerializer above --
  // Phase 2a increment 2's /set-password carries a bearer token in its query
  // string (`?tid=...&t=...`), and OAUTH-AS-PLAN.md section 5.13 requires it
  // never be logged in the clear.
  const loggerOption =
    opts.logger === false
      ? (false as const)
      : {
          serializers: { req: reqSerializer },
          ...(opts.loggerStream !== undefined ? { stream: opts.loggerStream } : {}),
        };
  // trustProxy: true, matching services/api/src/main.ts's Fastify root app.
  // Caddy fronts auth.brain.fi exactly like it fronts api.brain.fi (same
  // Caddyfile), so without this every request arrives from the Caddy
  // container's address, req.ip is constant, and @fastify/rate-limit's
  // default IP keyGenerator collapses every distinct client into one bucket
  // -- 5 /forgot-password requests/minute total, not per client (finding 4).
  // Not narrowed to a specific proxy hop count/CIDR: services/api takes the
  // same blanket `true` for the same single-hop Caddy topology, and diverging
  // here would make the two deployables' trust boundary inconsistent for no
  // documented reason.
  const app = Fastify({ logger: loggerOption, disableRequestLogging: false, trustProxy: true });

  // registerAuthSecurityHeaders (security-headers.ts) is a from-scratch
  // equivalent of services/api/src/security-headers.ts's registerSecurityHeaders
  // -- not importable here without depending on @brain/api, which is not
  // exported as a workspace package for reuse (only "." is in its package.json
  // "exports", and that export carries the whole API's boot). CSP-with-nonces
  // matters starting this increment's /login, /set-password, and
  // /forgot-password HTML pages; it is a strict improvement over Phase 1's
  // bare @fastify/helmet registration for the JSON discovery routes too.
  await registerAuthSecurityHeaders(app);
  await app.register(fastifyRateLimit, { max: 300, timeWindow: "1 minute" });

  // No client framework, no bundler -- but real <form method="post"> submits
  // as application/x-www-form-urlencoded, and Fastify parses only JSON by
  // default. node:url's URLSearchParams is the stdlib parser; no new
  // dependency for these routes' worth of form fields.
  //
  // A repeated key (the consent page's `scope_selected` checkboxes, Phase 2a
  // increment 3) becomes a string[] here; `Object.fromEntries` alone would
  // silently keep only the LAST value for a repeated key, which is exactly
  // wrong for a multi-select checkbox group. Every existing single-valued
  // field (login/set-password/forgot-password) is unaffected: a key with one
  // occurrence still comes through as a plain string.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body: string, done) => {
      try {
        const params = new URLSearchParams(body);
        const parsed: Record<string, string | string[]> = {};
        for (const key of new Set(params.keys())) {
          const values = params.getAll(key);
          parsed[key] = values.length > 1 ? values : (values[0] ?? "");
        }
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

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

  if (opts.oauthCore === undefined) {
    app.get("/authorize", async (_req, reply) => {
      reply.code(503);
      return TEMPORARILY_UNAVAILABLE;
    });

    app.post("/token", async (_req, reply) => {
      // RFC 6749 section 5.1 requires no-store on token-endpoint responses.
      reply.header("cache-control", "no-store").code(503);
      return TEMPORARILY_UNAVAILABLE;
    });
  }

  if (opts.humanAuth !== undefined) {
    await registerHumanAuthRoutes(app, opts.humanAuth);
  }

  // Must register after humanAuth: POST /authorize/consent's error path
  // reuses no route from routes/human-auth.ts, but resumePendingAuthorization
  // (routes/oauth.ts) is imported BY routes/human-auth.ts's POST /login, so
  // both modules are already loaded by the time either registers -- ordering
  // here only affects Fastify's route table, not module resolution.
  if (opts.oauthCore !== undefined) {
    await registerOauthRoutes(app, opts.oauthCore);
  }

  return app;
}
