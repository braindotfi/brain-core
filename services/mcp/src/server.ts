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
  requireScope,
  type AuditEmitter,
  type Scope,
  type IAgentService,
  type ILedgerService,
  type IPaymentIntentService,
  type IRawEvidenceService,
  type IWikiMemoryService,
  type Principal,
  type Proof,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
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
import type {
  EvidenceToolService,
  ProposalToolService,
  Tool,
  ToolContext,
  ToolResult,
} from "./tools/types.js";
import { listResources, readResource } from "./resources.js";
import { getPrompt, listPrompts } from "./prompts.js";
import type { AuthVerifier } from "./auth.js";

export interface McpServerDeps {
  auth: AuthVerifier;
  ledger: ILedgerService;
  wiki: IWikiMemoryService;
  raw: IRawEvidenceService;
  rawReaderPool?: Pool;
  paymentIntents: IPaymentIntentService;
  /** Optional. When absent, agent.action.propose returns internal_server_error. */
  agentService?: IAgentService;
  /** Optional until proposal tools are wired by the API composition root. */
  proposals?: ProposalToolService;
  /** Optional until evidence tools are wired by the API composition root. */
  evidence?: EvidenceToolService;
  audit: AuditEmitter;
  /** Optional H-07 proof builder — wires the brain://proofs/{action_id} resource. */
  buildProof?: (tenantId: string, actionId: string) => Promise<Proof | null>;
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

    // Agent principals are verified against the MCP agent registry before any
    // method dispatch. User principals are already authenticated by the upstream
    // JWT middleware and pass through as user service context so human-only
    // proposal decisions can reuse the same ActorResolver path as HTTP.
    let agent: Awaited<ReturnType<AuthVerifier["verify"]>>["agent"] | undefined;
    let serviceCtx: ServiceCallContext;
    if (principal.type === "agent") {
      try {
        const auth = await this.deps.auth.verify(principal);
        agent = auth.agent;
        serviceCtx = {
          ...auth.ctx,
          requestId,
          principalType: principal.type,
          scopes: principal.scopes,
        };
      } catch (err) {
        await this.emitRejectionAudit(principal, "auth.verify", err);
        throw err;
      }
    } else {
      serviceCtx = {
        tenantId: principal.tenantId,
        actor: principal.id,
        requestId,
        principalType: principal.type,
        scopes: principal.scopes,
      };
    }
    const buildProof = this.deps.buildProof;
    const tenantId = serviceCtx.tenantId;
    const toolCtx: ToolContext = {
      ctx: serviceCtx,
      ...(agent !== undefined ? { agent } : {}),
      ledger: this.deps.ledger,
      wiki: this.deps.wiki,
      raw: this.deps.raw,
      ...(this.deps.rawReaderPool !== undefined ? { rawReaderPool: this.deps.rawReaderPool } : {}),
      paymentIntents: this.deps.paymentIntents,
      ...(this.deps.agentService !== undefined ? { agentService: this.deps.agentService } : {}),
      ...(this.deps.proposals !== undefined ? { proposals: this.deps.proposals } : {}),
      ...(this.deps.evidence !== undefined ? { evidence: this.deps.evidence } : {}),
      audit: this.deps.audit,
      // Bind the tenant on the ToolContext so resources don't have to re-derive it.
      ...(buildProof !== undefined
        ? { buildProof: (actionId: string) => buildProof(tenantId, actionId) }
        : {}),
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
    // Batch 12: emit `agent.mcp.tool_called` on rejection too. Every branch
    // below (unknown tool, scope mismatch, parse fail, handler throw) used
    // to leave NO audit row, so a determined caller could probe the
    // surface invisibly. Now each rejection emits with `ok: false` and the
    // brainError code attached to outputs.
    const label = typeof params.name === "string" ? params.name : "<missing>";
    try {
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
    } catch (err) {
      await this.emitOuterAudit(ctx, label, false, {
        error_code: extractErrorCode(err),
      });
      throw err;
    }
  }

  private async resourcesRead(
    ctx: ToolContext,
    params: Record<string, unknown>,
    scopes: ReadonlyArray<string>,
  ): Promise<ResourceReadResult> {
    // Batch 12: same rejection-audit treatment as toolsCall.
    const uri = typeof params.uri === "string" ? params.uri : "<missing>";
    const label = `resources.read:${uri}`;
    try {
      if (typeof params.uri !== "string") invalidParams("'uri' is required");
      const { result, requiredScopes } = await readResource(params.uri as string, ctx);
      requireAll(scopes, requiredScopes);
      await this.emitOuterAudit(ctx, label, true, { uri });
      return result;
    } catch (err) {
      await this.emitOuterAudit(ctx, label, false, {
        uri,
        error_code: extractErrorCode(err),
      });
      throw err;
    }
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

  /**
   * Batch 12: audit row for a request that never made it past the auth
   * verifier (no verified ctx). The principal is what got rejected, so the
   * row keys to its CLAIMED tenant + agent id. Caller still re-throws after
   * we return -- the audit is best-effort and never modifies the outcome.
   */
  private async emitRejectionAudit(
    principal: Principal,
    stage: string,
    err: unknown,
  ): Promise<void> {
    try {
      await this.deps.audit.emit({
        tenantId: principal.tenantId,
        layer: "agent",
        actor: principal.id,
        action: "agent.mcp.tool_called",
        inputs: { tool: stage },
        outputs: { ok: false, error_code: extractErrorCode(err) },
      });
    } catch {
      // Audit-emitter failure must not mask the original rejection. Swallow
      // the secondary error; the request still rejects normally.
    }
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

/**
 * Best-effort `code` extraction for the audit row. brainError attaches a
 * `code` property; non-brain errors land as "unknown" so the audit row never
 * panics on a malformed payload.
 */
function extractErrorCode(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "unknown";
}

function enforceScopes(tool: Tool, scopes: ReadonlyArray<string>): void {
  for (const s of tool.requiredScopes) {
    try {
      requireScope(scopes, s as Scope);
    } catch (err) {
      throw brainError("auth_scope_insufficient", `tool '${tool.name}' requires scope '${s}'`, {
        details: { required: tool.requiredScopes, held: scopes, cause: extractErrorCode(err) },
      });
    }
  }
}

function requireAll(scopes: ReadonlyArray<string>, required: ReadonlyArray<string>): void {
  for (const r of required) {
    try {
      requireScope(scopes, r as Scope);
    } catch (err) {
      throw brainError("auth_scope_insufficient", `requires scope '${r}'`, {
        details: { required, held: scopes, cause: extractErrorCode(err) },
      });
    }
  }
}
