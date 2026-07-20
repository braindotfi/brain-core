/**
 * Fastify-compatible HTTP transport for the MCP server.
 *
 * One POST = one JSON-RPC request → one JSON-RPC response. The route
 * is registered by services/execution; this module just exports the
 * handler factory so services/execution doesn't import MCP internals.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, type SlidingWindowRateLimiter } from "@brain/shared";
import type { BrainMcpServer } from "../server.js";

export interface McpRouteOptions {
  /** Path the MCP server is mounted at. Default `/agents/mcp`. */
  path?: string;
  /** Skip principal_type=user|agent enforcement. Set to true only in dev-bypass mode. */
  skipPrincipalTypeCheck?: boolean;
  /**
   * Per-tenant sliding-window rate limiter. When supplied, every MCP request
   * is keyed by `tenantId` and rejected with `rate_limited` (HTTP 429) once
   * the configured window cap is exceeded. Prevents a single misbehaving
   * agent from crowding out other tenants on the shared MCP surface.
   *
   * The Fastify global rate limiter is still in front of this and caps total
   * QPS to the api process; this limiter adds tenant fairness on top.
   */
  tenantRateLimiter?: SlidingWindowRateLimiter;
  /**
   * RFC 9728 protected-resource metadata URL. When supplied, every 401 from
   * this route carries a `WWW-Authenticate: Bearer resource_metadata="…"`
   * challenge so MCP clients can discover Brain's authorization server and
   * begin an OAuth flow. Omit (e.g. in unit tests) to skip the header.
   */
  resourceMetadataUrl?: string;
}

/**
 * Register the MCP route on a Fastify instance. The route requires a
 * Bearer JWT handled by `authPlugin` upstream. The MCP surface accepts
 * registered agents for propose/read tools and user principals for human
 * proposal decisions. API partner principals are not allowed here.
 */
export async function registerMcpRoute(
  app: FastifyInstance,
  server: BrainMcpServer,
  opts: McpRouteOptions = {},
): Promise<void> {
  const path = opts.path ?? "/agents/mcp";

  // RFC 9728 §5.1: a protected resource SHOULD signal where its metadata lives
  // on auth failures. Pre-dispatch auth failures throw BrainErrors that the
  // shared error handler turns into a 401/403 envelope; this encapsulated hook
  // attaches the discovery challenge to those responses without touching the
  // global handler (so only the MCP surface advertises OAuth discovery).
  const resourceMetadataUrl = opts.resourceMetadataUrl;
  if (resourceMetadataUrl !== undefined) {
    app.addHook("onSend", async (_request, reply, payload) => {
      if (reply.statusCode === 401 || reply.statusCode === 403) {
        reply.header("www-authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
      }
      return payload;
    });
  }

  app.post(path, async (request: FastifyRequest, reply) => {
    if (request.principal === undefined) {
      throw brainError("auth_token_missing", "principal required");
    }
    if (
      !opts.skipPrincipalTypeCheck &&
      request.principal.type !== "agent" &&
      request.principal.type !== "user"
    ) {
      throw brainError("auth_scope_insufficient", "MCP requires principal_type=agent or user");
    }
    // Per-tenant rate limit. It runs after auth so an unauthenticated flood
    // cannot poison the limiter, and after the principal type check so only
    // allowed MCP principals consume tenant bucket capacity.
    if (opts.tenantRateLimiter !== undefined) {
      const decision = await opts.tenantRateLimiter.hit(`mcp:tenant:${request.principal.tenantId}`);
      if (!decision.allowed) {
        throw brainError("rate_limited", "tenant MCP quota exceeded", {
          details: {
            tenant_id: request.principal.tenantId,
            limit: decision.limit,
            window_count: decision.count,
          },
        });
      }
    }
    const response = await server.handle(request.body, request.principal);
    // JSON-RPC always returns 200 even on error; the error is in the
    // body. Clients distinguish success from failure by the presence of
    // `result` vs `error`.
    reply.status(200);
    return response;
  });
}
