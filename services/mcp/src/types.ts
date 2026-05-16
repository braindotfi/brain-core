/**
 * Brain MCP — wire-shape types.
 *
 * JSON-RPC 2.0 (https://www.jsonrpc.org/specification) plus the
 * subset of MCP method names Brain v0.3 exposes. We don't depend on
 * the official MCP SDK — the wire is small enough to own and
 * eliminating an external dep means one fewer hallucination surface
 * for AI assistants editing this code.
 */

export const JSON_RPC_VERSION = "2.0" as const;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: number | string | null;
  result: T;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcError;

// MCP method names Brain v0.3 supports. Anything not in this list
// returns -32601 method not found.
export const MCP_METHODS = [
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
] as const;

export type McpMethod = (typeof MCP_METHODS)[number];

export interface InitializeResult {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: {
    tools: { listChanged: boolean };
    resources: { listChanged: boolean; subscribe: boolean };
    prompts: { listChanged: boolean };
  };
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolListResult {
  tools: ToolDescriptor[];
}

export interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  /** Brain-specific result payload echoed alongside the textual content. */
  structuredContent?: unknown;
}

export interface ResourceDescriptor {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface ResourceListResult {
  resources: ResourceDescriptor[];
}

export interface ResourceReadResult {
  contents: Array<{
    uri: string;
    mimeType: string;
    text: string;
  }>;
}

export interface PromptDescriptor {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
}

export interface PromptListResult {
  prompts: PromptDescriptor[];
}

export interface PromptGetResult {
  description: string;
  messages: Array<{
    role: "user" | "assistant";
    content: { type: "text"; text: string };
  }>;
}

// Brain-specific JSON-RPC error codes. Standard JSON-RPC reserves
// -32099..-32000 for "implementation-defined server errors" — we use
// that range. Mapping to Brain's HTTP error registry lives in
// dispatcher.ts.
export const BRAIN_ERROR_CODES = {
  authTokenMissing: -32001,
  authScopeInsufficient: -32002,
  agentNotRegistered: -32003,
  paymentIntentGateFailed: -32004,
  agentScopeHashMismatch: -32005,
} as const;

// JSON-RPC standard codes we use.
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

export const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_INFO = { name: "brain-mcp", version: "0.3.0" } as const;
