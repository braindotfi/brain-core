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
import type { McpShadowBinding, McpShadowMetering, McpToolMeterOutcome } from "../metering.js";
import { isSupportedProtocolVersion } from "../types.js";

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
  /** Observe and meter tool calls only for the configured shadow tenant. */
  shadowMetering?: McpShadowMetering;
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
    const toolName = requestedToolName(request.body);
    const occurredAt = new Date();
    const decision =
      opts.tenantRateLimiter === undefined
        ? undefined
        : await opts.tenantRateLimiter.hit(`mcp:tenant:${request.principal.tenantId}`);
    const shadowBinding =
      toolName === null || opts.shadowMetering === undefined
        ? null
        : await opts.shadowMetering.observeTransport({
            requestId: String(request.id),
            principal: request.principal,
            toolName,
            limiterDecision: decision?.allowed ?? true,
            occurredAt,
          });
    if (decision !== undefined && !decision.allowed) {
      await recordToolSafely(request, opts.shadowMetering, shadowBinding, {
        statusCode: 429,
        outcome: "rate_limited",
        rejectionReason: "rate_limited",
      });
      throw brainError("rate_limited", "tenant MCP quota exceeded", {
        details: {
          tenant_id: request.principal.tenantId,
          limit: decision.limit,
          window_count: decision.count,
        },
      });
    }
    // MCP spec (HTTP transport): once a client has completed `initialize`, it
    // MUST send `MCP-Protocol-Version` on subsequent requests. This server is
    // stateless per-request (no session), so it cannot check the header
    // against a version actually negotiated earlier -- there is no session to
    // hold that state. What it CAN do, and what this checks, is reject a
    // header naming a version this server never supported at all, per the
    // spec's "If the server receives a request with an invalid or unsupported
    // MCP-Protocol-Version, it MUST respond with 400 Bad Request." An absent
    // header is not an error here (the spec's back-compat fallback assumes a
    // default version in that case; this server does not need to pick one
    // since every request already carries its own principal and scopes).
    const protocolVersionHeader = request.headers["mcp-protocol-version"];
    if (
      typeof protocolVersionHeader === "string" &&
      !isSupportedProtocolVersion(protocolVersionHeader)
    ) {
      await recordToolSafely(request, opts.shadowMetering, shadowBinding, {
        statusCode: 400,
        outcome: "client_error",
        rejectionReason: "unsupported_protocol_version",
      });
      throw brainError(
        "request_params_invalid",
        `unsupported MCP-Protocol-Version: ${protocolVersionHeader}`,
        { details: { header: protocolVersionHeader } },
      );
    }
    let response;
    try {
      response = await server.handle(request.body, request.principal);
    } catch (err) {
      const classified = classifyThrownError(err);
      await recordToolSafely(request, opts.shadowMetering, shadowBinding, classified);
      throw err;
    }
    const classified = classifyResponse(response);
    await recordToolSafely(request, opts.shadowMetering, shadowBinding, classified);
    if (response === null) {
      // JSON-RPC notification: the spec forbids a response body. Streamable
      // HTTP's answer is 202 Accepted with nothing in it -- not a 200 with an
      // empty JSON-RPC envelope, which would itself be a malformed response.
      // `reply.send()` with no argument is what actually produces an empty
      // body here -- returning `null` from the handler would have Fastify
      // JSON-serialize it to the literal text "null", which is not empty.
      return reply.status(202).send();
    }
    // JSON-RPC always returns 200 even on error; the error is in the
    // body. Clients distinguish success from failure by the presence of
    // `result` vs `error`.
    reply.status(200);
    return response;
  });
}

function requestedToolName(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (value.jsonrpc !== "2.0" || value.method !== "tools/call") return null;
  const params = value.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return "<unclassified>";
  }
  const name = (params as Record<string, unknown>).name;
  return typeof name === "string" && name.length > 0 ? name : "<unclassified>";
}

function classifyResponse(response: Awaited<ReturnType<BrainMcpServer["handle"]>>): {
  statusCode: number;
  outcome: McpToolMeterOutcome;
  rejectionReason: string | null;
} {
  if (response === null) {
    return { statusCode: 202, outcome: "client_error", rejectionReason: "notification_unmetered" };
  }
  if (!("error" in response)) {
    return { statusCode: 200, outcome: "success", rejectionReason: null };
  }
  if (response.error.code === -32002) {
    return { statusCode: 200, outcome: "scope_rejected", rejectionReason: "scope_rejected" };
  }
  if (response.error.code === -32001 || response.error.code === -32003) {
    return { statusCode: 200, outcome: "auth_rejected", rejectionReason: "auth_rejected" };
  }
  return {
    statusCode: 200,
    outcome: response.error.code === -32603 ? "server_error" : "client_error",
    rejectionReason: "json_rpc_error",
  };
}

function classifyThrownError(err: unknown): {
  statusCode: number;
  outcome: McpToolMeterOutcome;
  rejectionReason: string;
} {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "internal_server_error";
  if (code === "auth_scope_insufficient" || code === "auth_tenant_mismatch") {
    return { statusCode: 403, outcome: "scope_rejected", rejectionReason: code };
  }
  if (code.startsWith("auth_") || code.startsWith("agent_")) {
    return { statusCode: 401, outcome: "auth_rejected", rejectionReason: code };
  }
  return { statusCode: 500, outcome: "server_error", rejectionReason: code };
}

async function recordToolSafely(
  request: FastifyRequest,
  metering: McpShadowMetering | undefined,
  binding: McpShadowBinding | null,
  result: {
    statusCode: number;
    outcome: McpToolMeterOutcome;
    rejectionReason: string | null;
  },
): Promise<void> {
  if (metering === undefined || binding === null) return;
  try {
    await metering.recordTool({ binding, ...result });
  } catch (err) {
    request.log.error(
      { error_name: errorName(err), request_id: binding.requestId },
      "MCP shadow meter append failed",
    );
    try {
      await metering.recordMeterFailure(binding);
    } catch (failureErr) {
      request.log.error(
        { error_name: errorName(failureErr), request_id: binding.requestId },
        "MCP shadow meter failure evidence append failed",
      );
    }
  }
}

function errorName(value: unknown): string {
  return value instanceof Error ? value.name : "UnknownError";
}
