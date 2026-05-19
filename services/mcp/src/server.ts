/**
 * BrainMcpServer — the JSON-RPC dispatcher tied to Brain's services.
 *
 * One server instance per app boot. The server is stateless — every
 * request carries its principal via the JWT and the AuthVerifier
 * resolves the agent + scope. State that persists (e.g. the on-chain
 * scope-hash cache) lives inside the AuthVerifier instance, not here.
 *
 * The server exposes a single method, `handle(payload, principal)`,
 * which the HTTP transport calls per request.
 */

import {
  brainError,
  newRequestId,
  type AuditEmitter,
  type IAgentService,
  type ILedgerService,
  type IPaymentIntentService,
  type IRawEvidenceService,
  type IWikiMemoryService,
  type Principal,
} from "@brain/shared";
import { dispatch, invalidParams, type JsonRpcHandler } from "./dispatcher.js";
import {
  PROTOCOL_VERSION,
  SERVER_INFO,
  type InitializeResult,
  type JsonRpcResponse,
  type PromptGetResult,
  type PromptListResult,
  type ResourceListResult,
  type ResourceReadResult,
  type ToolCallResult,
  type ToolListResult,
} from "./types.js";
import { findTool, toolDescriptors } from "./tools/registry.js";
import type { Tool, ToolContext, ToolResult } from "./tools/types.js";
import { listResources, readResource } from "./resources.js";
import { getPrompt, listPrompts } from "./prompts.js";
import type { AuthVerifier } from "./auth.js";

export interface McpServerDeps {
  auth: AuthVerifier;
  ledger: ILedgerService;
  wiki: IWikiMemoryService;
  raw: IRawEvidenceService;
  paymentIntents: IPaymentIntentService;
  /** Optional. When unwired, agent.action.propose returns an audit-only stub. */
  agentService?: IAgentService;
  audit: AuditEmitter;
}

export class BrainMcpServer {
  public constructor(private readonly deps: McpServerDeps) {}

  /**
   * Handle a single JSON-RPC payload. The principal MUST already be
   * authenticated by `authPlugin` upstream — the only verification this
   * function does is the MCP-specific agent-record + scope-hash check.
   */
  public async handle(payload: unknown, principal: Principal): Promise<JsonRpcResponse> {
    const requestId = newRequestId();

    // Verify the agent FIRST. Any failure here returns a JSON-RPC error
    // before we even look at the method name.
    const auth = await this.deps.auth.verify(principal);
    const toolCtx: ToolContext = {
      ctx: { ...auth.ctx, requestId },
      agent: auth.agent,
      ledger: this.deps.ledger,
      wiki: this.deps.wiki,
      raw: this.deps.raw,
      paymentIntents: this.deps.paymentIntents,
      ...(this.deps.agentService !== undefined ? { agentService: this.deps.agentService } : {}),
      audit: this.deps.audit,
    };

    const handlers: Record<string, JsonRpcHandler> = {
      initialize: async () => this.initialize(),
      ping: async () => ({}),
      "tools/list": async () => this.toolsList(principal.scopes),
      "tools/call": async (params) => this.toolsCall(toolCtx, params, principal.scopes),
      "resources/list": async () => listResources(),
      "resources/read": async (params) => this.resourcesRead(toolCtx, params, principal.scopes),
      "prompts/list": async () => listPrompts(),
      "prompts/get": async (params) => this.promptsGet(params),
    };

    return dispatch(payload, { handlers }, { requestId });
  }

  // ---------- method implementations ----------------------------------

  private initialize(): InitializeResult {
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: SERVER_INFO,
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
        prompts: { listChanged: false },
      },
    };
  }

  /**
   * `tools/list` returns the full registry. Per the architecture doc,
   * we list everything regardless of scope — the agent sees the
   * surface, but `tools/call` is what enforces the scope gate.
   */
  private toolsList(_scopes: ReadonlyArray<string>): ToolListResult {
    return { tools: toolDescriptors() };
  }

  private async toolsCall(
    ctx: ToolContext,
    params: Record<string, unknown>,
    scopes: ReadonlyArray<string>,
  ): Promise<ToolCallResult> {
    if (typeof params.name !== "string") invalidParams("'name' is required");
    const tool = findTool(params.name as string);
    if (tool === undefined) {
      throw brainError("request_params_invalid", `unknown tool: ${params.name}`, {
        details: { name: params.name, available: toolDescriptors().map((t) => t.name) },
      });
    }
    enforceScopes(tool, scopes);

    const argsRaw =
      typeof params.arguments === "object" &&
      params.arguments !== null &&
      !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    const input = tool.parseInput(argsRaw);
    const result = await tool.handle(ctx, input);
    await this.emitOuterAudit(ctx, tool.name, true, { result_kind: "tool_result" });

    return shapeToolResult(result);
  }

  private async resourcesRead(
    ctx: ToolContext,
    params: Record<string, unknown>,
    scopes: ReadonlyArray<string>,
  ): Promise<ResourceReadResult> {
    const uri = params.uri;
    if (typeof uri !== "string") invalidParams("'uri' is required");
    const { result, requiredScopes } = await readResource(uri as string, ctx);
    requireAll(scopes, requiredScopes);
    await this.emitOuterAudit(ctx, `resources.read:${uri}`, true, { uri });
    return result;
  }

  private promptsGet(params: Record<string, unknown>): PromptGetResult {
    const name = params.name;
    if (typeof name !== "string") invalidParams("'name' is required");
    const argsRaw =
      typeof params.arguments === "object" &&
      params.arguments !== null &&
      !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    // Coerce values to strings; prompts only support string args at v0.3.
    const args: Record<string, string> = {};
    for (const [k, v] of Object.entries(argsRaw)) {
      if (typeof v === "string") args[k] = v;
      else if (typeof v === "number") args[k] = String(v);
    }
    return getPrompt(name as string, args);
  }

  // ---------- audit -----------------------------------------------------

  private async emitOuterAudit(
    ctx: ToolContext,
    label: string,
    ok: boolean,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.emit({
      tenantId: ctx.ctx.tenantId,
      layer: "agent",
      actor: ctx.ctx.actor,
      action: "agent.mcp.tool_called",
      inputs: { tool: label },
      outputs: { ok, ...extra },
    });
  }

  /** Test-only: forces a list response without going through dispatcher. */
  public _testInitialize(): InitializeResult {
    return this.initialize();
  }

  /** Used by promise-list assertions: how many tools the registry exposes. */
  public _testToolCount(): number {
    return toolDescriptors().length;
  }

  // PromptListResult is referenced via type imports at the call site;
  // void it to satisfy unused-import pruning during partial builds.
  protected _typeRefs(): {
    list: PromptListResult;
    res: ResourceListResult;
    tools: ToolListResult;
  } {
    return {} as never;
  }
}

// ---------- helpers ---------------------------------------------------

function shapeToolResult(result: ToolResult): ToolCallResult {
  return {
    content: [{ type: "text", text: result.summary }],
    structuredContent: result.payload,
  };
}

function enforceScopes(tool: Tool, scopes: ReadonlyArray<string>): void {
  for (const s of tool.requiredScopes) {
    if (!scopes.includes(s)) {
      throw brainError("auth_scope_insufficient", `tool '${tool.name}' requires scope '${s}'`, {
        details: { required: tool.requiredScopes, held: scopes },
      });
    }
  }
}

function requireAll(scopes: ReadonlyArray<string>, required: ReadonlyArray<string>): void {
  for (const r of required) {
    if (!scopes.includes(r)) {
      throw brainError("auth_scope_insufficient", `requires scope '${r}'`, {
        details: { required, held: scopes },
      });
    }
  }
}
