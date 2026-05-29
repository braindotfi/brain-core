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
  /** Skip principal_type=agent enforcement. Set to true only in dev-bypass mode. */
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
}

/**
 * Register the MCP route on a Fastify instance. The route requires a
 * Bearer JWT (handled by `authPlugin` upstream) — we just check that
 * `request.principal` exists and has principal_type=agent before
 * delegating to the server.
 */
export async function registerMcpRoute(
  app: FastifyInstance,
  server: BrainMcpServer,
  opts: McpRouteOptions = {},
): Promise<void> {
  const path = opts.path ?? "/agents/mcp";

  app.post(path, async (request: FastifyRequest, reply) => {
    if (request.principal === undefined) {
      throw brainError("auth_token_missing", "principal required");
    }
    if (!opts.skipPrincipalTypeCheck && request.principal.type !== "agent") {
      throw brainError("auth_scope_insufficient", "MCP requires principal_type=agent");
    }
    // Per-tenant rate limit (must run AFTER auth so an unauthenticated flood
    // can't poison the limiter, and AFTER the principal_type check so user
    // tokens hit the global limiter rather than the tenant bucket).
    if (opts.tenantRateLimiter !== undefined) {
      const decision = await opts.tenantRateLimiter.hit(
        `mcp:tenant:${request.principal.tenantId}`,
      );
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
