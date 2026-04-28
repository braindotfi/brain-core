/**
 * @brain/mcp — Brain's MCP (Model Context Protocol) server.
 *
 * External AI agents connect through this surface using any
 * MCP-compatible client. Tools / resources / prompts call into the same
 * Brain services the HTTP API uses, so policy gating + audit emission
 * are identical to the HTTP path.
 */

export const SERVICE_NAME = "brain-mcp" as const;

export { BrainMcpServer, type McpServerDeps } from "./server.js";
export {
  McpAuthVerifier,
  FakeAuthVerifier,
  type AuthVerifier,
  type AgentRecord,
  type OnchainScopeChecker,
} from "./auth.js";
export { registerMcpRoute, type McpRouteOptions } from "./transport/http.js";
export { ALL_TOOLS, findTool, toolDescriptors } from "./tools/registry.js";
export type { Tool, ToolContext, ToolResult } from "./tools/types.js";
export { listResources, readResource, parseBrainUri } from "./resources.js";
export { listPrompts, getPrompt } from "./prompts.js";
export {
  PROTOCOL_VERSION,
  SERVER_INFO,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ToolCallResult,
} from "./types.js";
