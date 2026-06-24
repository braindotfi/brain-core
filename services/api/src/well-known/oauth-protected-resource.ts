/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP surface.
 *
 *   GET /.well-known/oauth-protected-resource → application/json
 *
 * Root-mounted (not under `/v1`) and public (`skipAuth: true`) — it carries no
 * tenant data, only the discovery document an MCP client reads to find Brain's
 * authorization server. This is the OAuth-discovery half of the canonical
 * `mcp.brain.fi` work: the host Caddy proxies `/.well-known/oauth-protected-resource`
 * straight through to this route, and the MCP 401 challenge points clients here
 * (see the `WWW-Authenticate` header set in `@brain/mcp` `registerMcpRoute`).
 *
 * The full authorization server (`/authorize`, `/token`, PKCE, dynamic client
 * registration) is a separate, later workstream living at `AUTH_ISSUER`; this
 * route only advertises where that server is, so it can ship independently.
 */

import type { FastifyInstance } from "fastify";

/** RFC 9728 §3.1 metadata document (only the fields Brain populates). */
export interface OAuthProtectedResourceMetadata {
  /** The protected resource's identifier — the canonical public MCP origin. */
  readonly resource: string;
  /** Authorization servers that can issue tokens for this resource. */
  readonly authorization_servers: readonly string[];
  /** Scopes the resource understands (the external-agent permitted set). */
  readonly scopes_supported: readonly string[];
  /** How the bearer token may be presented. Brain accepts the header only. */
  readonly bearer_methods_supported: readonly string[];
}

export interface OAuthProtectedResourceRouteOptions {
  /** `MCP_PUBLIC_RESOURCE_URL` — the canonical public MCP origin. */
  readonly resource: string;
  /** Authorization server issuer(s) — typically `[AUTH_ISSUER]`. */
  readonly authorizationServers: readonly string[];
  /** Scopes advertised as understood — the external-agent permitted set. */
  readonly scopesSupported: readonly string[];
}

/** The well-known path the metadata document is served at (RFC 9728). */
export const OAUTH_PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

/**
 * RFC 9728 §3.1: the metadata URL is the resource identifier with
 * `/.well-known/oauth-protected-resource` inserted at the path root. For a
 * bare-origin resource (`https://mcp.brain.fi`) that is simply the origin
 * followed by the well-known path. Exported so the MCP route can embed the same
 * URL in its `WWW-Authenticate` challenge without re-deriving it.
 */
export function resourceMetadataUrl(resource: string): string {
  return `${resource.replace(/\/+$/, "")}${OAUTH_PROTECTED_RESOURCE_PATH}`;
}

const PUBLIC = { config: { skipAuth: true } } as const;

export async function registerOAuthProtectedResourceRoute(
  app: FastifyInstance,
  opts: OAuthProtectedResourceRouteOptions,
): Promise<void> {
  const body: OAuthProtectedResourceMetadata = {
    resource: opts.resource,
    authorization_servers: opts.authorizationServers,
    scopes_supported: opts.scopesSupported,
    bearer_methods_supported: ["header"],
  };

  app.get(OAUTH_PROTECTED_RESOURCE_PATH, PUBLIC, async (_req, reply) => {
    reply.header("content-type", "application/json; charset=utf-8");
    return body;
  });
}
