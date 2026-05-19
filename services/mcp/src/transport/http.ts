/**
 * Fastify-compatible HTTP transport for the MCP server.
 *
 * One POST = one JSON-RPC request → one JSON-RPC response. The route
 * is registered by services/execution; this module just exports the
 * handler factory so services/execution doesn't import MCP internals.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError } from "@brain/shared";
import type { BrainMcpServer } from "../server.js";

export interface McpRouteOptions {
  /** Path the MCP server is mounted at. Default `/agents/mcp`. */
  path?: string;
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
    if (request.principal.type !== "agent") {
      throw brainError("auth_scope_insufficient", "MCP requires principal_type=agent");
    }
    const response = await server.handle(request.body, request.principal);
    // JSON-RPC always returns 200 even on error; the error is in the
    // body. Clients distinguish success from failure by the presence of
    // `result` vs `error`.
    reply.status(200);
    return response;
  });
}
