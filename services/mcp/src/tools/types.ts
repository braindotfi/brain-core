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
  Scope,
  IAgentService,
  ILedgerService,
  IPaymentIntentService,
  IRawEvidenceService,
  IWikiMemoryService,
  Proof,
  ServiceCallContext,
} from "@brain/shared";
import { brainError } from "@brain/shared";
import type {
  EvidenceResolveRef,
  EvidenceResolveResult,
  ListProposalsInput,
  ListProposalsResult,
  ProposalDecision,
  ProposalDecisionResult,
  ProposalReadItem,
} from "@brain/execution";
import type { AgentRecord } from "../auth.js";

export interface ProposalToolService {
  list(ctx: ServiceCallContext, input: ListProposalsInput): Promise<ListProposalsResult>;
  get(ctx: ServiceCallContext, id: string): Promise<ProposalReadItem | null>;
  decide(
    ctx: ServiceCallContext,
    id: string,
    decision: ProposalDecision,
  ): Promise<ProposalDecisionResult>;
}

export interface EvidenceToolService {
  resolve(
    ctx: ServiceCallContext,
    refs: readonly EvidenceResolveRef[],
  ): Promise<readonly EvidenceResolveResult[]>;
}

export interface ToolContext {
  ctx: ServiceCallContext;
  agent?: AgentRecord;
  ledger: ILedgerService;
  wiki: IWikiMemoryService;
  raw: IRawEvidenceService;
  paymentIntents: IPaymentIntentService;
  /** Optional — the Agent layer's proposal service. Wired when AGENT_SERVICE_URL
   *  is set; agent.action.propose returns internal_server_error when absent. */
  agentService?: IAgentService;
  /** Optional until the API composition root wires proposal read and decision services. */
  proposals?: ProposalToolService;
  /** Optional until the API composition root wires evidence resolution. */
  evidence?: EvidenceToolService;
  audit: AuditEmitter;
  /**
   * Optional — builds the canonical H-07 Proof for an action id. Wired by the
   * api boot from the same `poolProofBuilder` the HTTP /v1/proof/{id} route
   * uses, so the MCP `brain://proofs/{action_id}` resource and the HTTP route
   * return byte-identical JSON. Absent ⇒ the MCP resource returns an error.
   */
  buildProof?: (actionId: string) => Promise<Proof | null>;
}

export interface ToolResult {
  /** Brain's structured payload — echoed in the MCP response and used
   *  for structured-content extraction. Serialized as JSON. */
  payload: unknown;
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

export function requireAgentContext(ctx: ToolContext, toolName: string): AgentRecord {
  if (ctx.agent === undefined) {
    throw brainError("auth_scope_insufficient", `${toolName} requires principal_type=agent`, {
      details: { principal_type: ctx.ctx.principalType ?? "unknown" },
    });
  }
  return ctx.agent;
}

export function requireToolService<T>(service: T | undefined, toolName: string): T {
  if (service === undefined) {
    throw brainError("dependency_unavailable", `${toolName} is not configured`);
  }
  return service;
}

/** Helper used by every tool's parseInput when a string field is required. */
export function requireString(params: Record<string, unknown>, name: string): string {
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

export function optionalString(params: Record<string, unknown>, name: string): string | undefined {
  const v = params[name];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function optionalNumber(params: Record<string, unknown>, name: string): number | undefined {
  const v = params[name];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function optionalInteger(params: Record<string, unknown>, name: string): number | undefined {
  const n = optionalNumber(params, name);
  if (n === undefined || !Number.isInteger(n)) return undefined;
  return n;
}

export function requireAnyScope(held: ReadonlyArray<string>, scopes: readonly Scope[]): void {
  for (const scope of scopes) {
    if (held.includes(scope) || held.includes(impliedAdmin(scope))) return;
  }
  throw brainError("auth_scope_insufficient", `requires one of: ${scopes.join(", ")}`, {
    details: { required: scopes, held },
  });
}

function impliedAdmin(scope: Scope): Scope {
  const [layer] = scope.split(":") as [string, string];
  return `${layer}:admin` as Scope;
}
