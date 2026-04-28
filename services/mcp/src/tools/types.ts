/**
 * MCP tool framework.
 *
 * Each tool is a small typed object: name, description, required scopes,
 * input schema, handler. The handler receives a `ToolContext` populated
 * by the server with the authenticated agent + the Brain service stubs.
 *
 * Tools never construct their own database connections or audit emitters;
 * everything they need is on the context. That makes them testable in
 * isolation with mock services.
 */

import type {
  AuditEmitter,
  IAgentService,
  ILedgerService,
  IPaymentIntentService,
  IRawEvidenceService,
  IWikiMemoryService,
  ServiceCallContext,
} from "@brain/api/shared";
import type { AgentRecord } from "../auth.js";

export interface ToolContext {
  ctx: ServiceCallContext;
  agent: AgentRecord;
  ledger: ILedgerService;
  wiki: IWikiMemoryService;
  raw: IRawEvidenceService;
  paymentIntents: IPaymentIntentService;
  /** Optional — the Agent layer's proposal service. Wired in production
   *  alongside the other services; tests may omit it (the
   *  agent.action.propose tool soft-degrades to an audit-only stub). */
  agentService?: IAgentService;
  audit: AuditEmitter;
}

export interface ToolResult {
  /** Brain's structured payload — echoed in the MCP response and used
   *  for structured-content extraction. */
  payload: Record<string, unknown>;
  /** Human-readable summary (markdown). MCP clients show this. */
  summary: string;
}

export interface Tool<TInput = unknown> {
  name: string;
  description: string;
  /** Brain scopes the agent must hold to call this tool. */
  requiredScopes: string[];
  /** JSON Schema for `tools/list` and runtime validation. */
  inputSchema: Record<string, unknown>;
  /** Validate the raw params and return a typed input or throw. */
  parseInput(params: Record<string, unknown>): TInput;
  /** Execute the tool. */
  handle(ctx: ToolContext, input: TInput): Promise<ToolResult>;
}

/** Helper used by every tool's parseInput when a string field is required. */
export function requireString(
  params: Record<string, unknown>,
  name: string,
): string {
  const v = params[name];
  if (typeof v !== "string" || v.length === 0) {
    throw {
      code: "request_params_invalid",
      message: `'${name}' is required`,
      details: { field: name },
    };
  }
  return v;
}

export function optionalString(
  params: Record<string, unknown>,
  name: string,
): string | undefined {
  const v = params[name];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function optionalNumber(
  params: Record<string, unknown>,
  name: string,
): number | undefined {
  const v = params[name];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
