/**
 * JSON-RPC 2.0 dispatcher.
 *
 * Parses an incoming HTTP body into a JsonRpcRequest, runs the matching
 * method handler, and shapes the result into a JsonRpcResponse. The
 * dispatcher is **transport-agnostic** — it takes a parsed body and
 * returns a response object; the Fastify integration in
 * `transport/http.ts` handles HTTP plumbing.
 *
 * The dispatcher does NOT know about Brain. Brain-specific handlers are
 * supplied as a registry in `BrainMcpServer.handle()`.
 */

import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
} from "./types.js";

export type JsonRpcHandler = (
  params: Record<string, unknown>,
  ctx: { requestId: string },
) => Promise<unknown>;

export interface DispatcherOptions {
  /** Method name → handler. */
  handlers: Record<string, JsonRpcHandler>;
  /** Hook called for every error before the response is shaped. */
  onError?: (err: unknown, method: string) => void;
}

/**
 * Parse a raw payload into a JsonRpcRequest. Returns null on parse
 * failure; callers translate that to a JSON_RPC_PARSE_ERROR response.
 */
export function parseRequest(payload: unknown): JsonRpcRequest | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;
  if (obj.jsonrpc !== "2.0") return null;
  if (typeof obj.method !== "string") return null;
  const id =
    obj.id === undefined
      ? null
      : typeof obj.id === "string" || typeof obj.id === "number" || obj.id === null
        ? obj.id
        : null;
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    method: obj.method,
    params: typeof obj.params === "object" && obj.params !== null && !Array.isArray(obj.params)
      ? (obj.params as Record<string, unknown>)
      : {},
  };
}

export async function dispatch(
  payload: unknown,
  opts: DispatcherOptions,
  ctx: { requestId: string },
): Promise<JsonRpcResponse> {
  const parsed = parseRequest(payload);
  if (parsed === null) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: JSON_RPC_PARSE_ERROR,
        message: "Parse error",
      },
    };
  }

  const handler = opts.handlers[parsed.method];
  if (handler === undefined) {
    return {
      jsonrpc: "2.0",
      id: parsed.id ?? null,
      error: {
        code: JSON_RPC_METHOD_NOT_FOUND,
        message: `Method not found: ${parsed.method}`,
      },
    };
  }

  try {
    const result = await handler(parsed.params ?? {}, ctx);
    return {
      jsonrpc: "2.0",
      id: parsed.id ?? null,
      result,
    };
  } catch (err) {
    opts.onError?.(err, parsed.method);
    return shapeError(parsed.id ?? null, err);
  }
}

/**
 * Shape an arbitrary error into a JSON-RPC error response. Recognizes
 * Brain's BrainError and maps its code to the implementation-defined
 * server-error range. Unknown errors become INTERNAL_ERROR.
 */
function shapeError(id: number | string | null, err: unknown): JsonRpcResponse {
  // Detect BrainError by shape rather than instanceof to keep the
  // dispatcher decoupled from @brain/api/shared. The auth + tools
  // modules raise BrainError; the server.ts wrapper translates by
  // matching on .code.
  const e = err as { code?: string; message?: string; details?: Record<string, unknown> };
  const codeStr = typeof e.code === "string" ? e.code : "internal_server_error";
  const message = typeof e.message === "string" ? e.message : "internal error";

  const map: Record<string, number> = {
    auth_token_missing: -32001,
    auth_token_invalid: -32001,
    auth_token_expired: -32001,
    auth_scope_insufficient: -32002,
    auth_tenant_mismatch: -32002,
    agent_not_registered: -32003,
    payment_intent_gate_failed: -32004,
    agent_scope_hash_mismatch: -32005,
    request_body_invalid: -32602,
    request_params_invalid: -32602,
  };

  const rpcCode = map[codeStr] ?? JSON_RPC_INTERNAL_ERROR;
  const data: Record<string, unknown> = { brain_code: codeStr };
  if (e.details !== undefined) data.details = e.details;

  return {
    jsonrpc: "2.0",
    id,
    error:
      rpcCode === JSON_RPC_INTERNAL_ERROR
        ? { code: rpcCode, message: "Internal error", data }
        : { code: rpcCode, message, data },
  };
}

/** Sentinel: marks a malformed `params` shape. */
export function invalidParams(message: string, details?: Record<string, unknown>): never {
  const err: { code: string; message: string; details?: Record<string, unknown> } = {
    code: "request_params_invalid",
    message,
  };
  if (details !== undefined) err.details = details;
  throw err;
}

void JSON_RPC_INVALID_REQUEST;
