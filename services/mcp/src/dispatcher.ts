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
 * Parses a raw payload into a JsonRpcRequest. A JSON-RPC 2.0 notification is
 * a Request object with the `id` member OMITTED entirely -- not present with
 * value `null`. We must preserve that distinction: `parsed.id === undefined`
 * means "this is a notification, do not respond"; `parsed.id === null` means
 * the caller sent an explicit (if unusual) null id on a request that still
 * expects a response. Collapsing the two, as this used to do, made every
 * notification -- including the mandatory `notifications/initialized`
 * handshake -- get back a JSON-RPC response, which the spec forbids.
 *
 * Returns null on parse failure; callers translate that to a
 * JSON_RPC_PARSE_ERROR response.
 */
export function parseRequest(payload: unknown): JsonRpcRequest | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;
  if (obj.jsonrpc !== "2.0") return null;
  if (typeof obj.method !== "string") return null;
  const hasId = obj.id !== undefined;
  const id =
    typeof obj.id === "string" || typeof obj.id === "number" || obj.id === null ? obj.id : null;
  return {
    jsonrpc: "2.0",
    ...(hasId ? { id } : {}),
    method: obj.method,
    params:
      typeof obj.params === "object" && obj.params !== null && !Array.isArray(obj.params)
        ? (obj.params as Record<string, unknown>)
        : {},
  };
}

/**
 * Dispatch a parsed JSON-RPC payload to its handler. Returns `null` for a
 * notification (no `id` on the request) -- per JSON-RPC 2.0, the server MUST
 * NOT send a response for a notification, success or failure. The HTTP
 * transport (transport/http.ts) turns a `null` return into `202 Accepted`
 * with an empty body instead of a JSON-RPC envelope.
 */
export async function dispatch(
  payload: unknown,
  opts: DispatcherOptions,
  ctx: { requestId: string },
): Promise<JsonRpcResponse | null> {
  const parsed = parseRequest(payload);
  if (parsed === null) {
    // A payload we cannot even parse as a Request has no reliable id to key
    // notification-ness off, so it always gets a response, same as before.
    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: JSON_RPC_PARSE_ERROR,
        message: "Parse error",
      },
    };
  }
  const isNotification = parsed.id === undefined;

  const handler = opts.handlers[parsed.method];
  if (handler === undefined) {
    if (isNotification) return null;
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
    if (isNotification) return null;
    return {
      jsonrpc: "2.0",
      id: parsed.id ?? null,
      result,
    };
  } catch (err) {
    opts.onError?.(err, parsed.method);
    if (isNotification) return null;
    return shapeError(parsed.id ?? null, err);
  }
}

/**
 * Brain error codes that fall through the numeric map below to
 * JSON_RPC_INTERNAL_ERROR but still carry a static, developer-authored
 * message (see dependency_unavailable and the explicit internal_server_error
 * call sites in resources.ts / tools/types.ts) -- safe to surface verbatim,
 * unlike an uncaught exception\x27s message, which can carry a stack trace, a
 * DB connection string, or other internal detail that never went through
 * brainError(...) at all.
 */
const SAFE_UNMAPPED_CODES = new Set<string>(["dependency_unavailable", "internal_server_error"]);

/**
 * Shape an arbitrary error into a JSON-RPC error response. Recognizes
 * Brain\x27s BrainError and maps its code to the implementation-defined
 * server-error range. Unknown errors become INTERNAL_ERROR.
 */
function shapeError(id: number | string | null, err: unknown): JsonRpcResponse {
  // Detect BrainError by shape rather than instanceof to keep the
  // dispatcher decoupled from @brain/api/shared. The auth + tools
  // modules raise BrainError; the server.ts wrapper translates by
  // matching on .code.
  const e = err as { code?: string; message?: string; details?: Record<string, unknown> };
  const hasBrainCode = typeof e.code === "string" && e.code.length > 0;
  const codeStr = hasBrainCode ? (e.code as string) : "internal_server_error";
  const message = typeof e.message === "string" ? e.message : "internal error";

  const map: Record<string, number> = {
    auth_token_missing: -32001,
    auth_token_invalid: -32001,
    auth_token_expired: -32001,
    auth_scope_insufficient: -32002,
    auth_tenant_mismatch: -32002,
    agent_not_registered: -32003,
    agent_not_registered_onchain: -32003,
    payment_intent_gate_failed: -32004,
    // Granular gate codes that replaced the payment_intent_gate_failed umbrella
    // map to the same gate-failed JSON-RPC code.
    gate_no_policy_decision: -32004,
    gate_policy_version_stale: -32004,
    gate_counterparty_unverified: -32004,
    gate_counterparty_sanctioned: -32004,
    gate_balance_insufficient: -32004,
    gate_approval_incomplete: -32004,
    gate_session_key_invalid: -32004,
    gate_audit_chain_stale: -32004,
    agent_scope_hash_mismatch: -32005,
    request_body_invalid: -32602,
    request_params_invalid: -32602,
    // Not-found family: the caller supplied an id that does not resolve to
    // anything under this tenant. JSON-RPC has no dedicated "not found"
    // code, so -32602 (Invalid params) is the closest standard fit -- the
    // params named something that does not exist, a caller-input problem,
    // not a server fault. These used to fall through to the unmapped
    // default and get their message discarded, so a typo\x27d id was
    // indistinguishable from a server crash.
    execution_proposal_not_found: -32602,
    raw_artifact_not_found: -32602,
    payment_intent_not_found: -32602,
    proof_not_found: -32602,
    ledger_row_not_found: -32602,
    wiki_page_not_found: -32602,
    // Same "caller\x27s request does not apply" shape as the not-found family
    // above, just keyed by state/authorization instead of existence.
    payment_intent_invalid_state: -32602,
    payment_intent_approval_invalid: -32602,
  };

  const rpcCode = map[codeStr] ?? JSON_RPC_INTERNAL_ERROR;
  const data: Record<string, unknown> = { brain_code: codeStr };
  if (e.details !== undefined) data.details = e.details;

  // Redact the message only when we cannot tell it came from a Brain error
  // with a static, developer-authored string -- i.e. a genuinely uncaught
  // exception (DB driver error, network fault, etc.) that never went
  // through brainError(...) at all. Every explicitly mapped code above
  // keeps its message by construction (rpcCode !== INTERNAL_ERROR);
  // SAFE_UNMAPPED_CODES covers the handful of codes that are deliberately
  // internal-error-class but still have a safe message.
  const redact =
    rpcCode === JSON_RPC_INTERNAL_ERROR && !(hasBrainCode && SAFE_UNMAPPED_CODES.has(codeStr));

  return {
    jsonrpc: "2.0",
    id,
    error: redact
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
