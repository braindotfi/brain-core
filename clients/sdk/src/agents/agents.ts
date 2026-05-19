/**
 * `brain.agents.*` — agent lifecycle and proposal API (Layer 5).
 *
 * Source pages:
 *   - https://docs.brain.fi/api-reference/agents-api
 *   - https://docs.brain.fi/sdks/agents-and-actions
 *   - https://docs.brain.fi/build/let-an-external-agent-in
 *
 * v0.3 commit scope: `register`, `propose`, `list`, `get`. The
 * `pause` / `resume` / `grantScope` / `revoke` / `reputation` /
 * `attest` methods land alongside their HTTP routes in PLAN-FIRST #14.
 *
 * @packageDocumentation
 */

import type { BrainHttp } from "../http/index.js";
import type { Action } from "../actions/index.js";
import type { Components } from "../index.js";

type Schemas = Components["schemas"];
export type Agent = Schemas["Agent"];

/**
 * Canonical agent capability vocabulary per docs/sdk-audit.md decision C.
 * The set the MCP tool registry enforces. Other vocabularies that appear
 * in the docs (`["read","propose_payment","propose_action"]`,
 * `["pay_invoice","rebalance_treasury"]`) are doc-side abbreviations
 * that resolve to a subset of these scopes.
 */
export const AGENT_CAPABILITIES = [
  "ledger:read",
  "wiki:read",
  "raw:write",
  "payment_intent:propose",
  "agent:propose",
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export interface RegisterAgentInput {
  /** Ethereum address of the agent. */
  readonly address: string;
  /** ERC-8004 identity root (off-chain attestation hash). */
  readonly identityRoot?: string;
  /** Agent's MCP endpoint URL. */
  readonly mcpEndpoint?: string;
  /** Capabilities to request. The tenant authorizes via grantScope later. */
  readonly capabilities: readonly AgentCapability[];
  /** Optional IPFS / external metadata URI. */
  readonly metadataUri?: string;
  /** Role classification, per spec `Agent.role` enum. */
  readonly role?: string;
  readonly displayName?: string;
  readonly idempotencyKey?: string;
}

export interface RegisterAgentResult {
  readonly id: string;
  readonly address: string;
  readonly identity_root?: string;
  readonly reputation_root?: string;
  readonly txHash?: string;
  readonly scope_hash?: string;
}

export interface ListAgentsOptions {
  readonly tenantId?: string;
}

export interface ProposeOptions {
  readonly tenantId: string;
  readonly agentId: string;
  readonly action: { readonly type: string; readonly [k: string]: unknown };
  readonly idempotencyKey?: string;
}

export interface ProposeResult {
  readonly actionId: string;
  readonly action: Action;
  readonly decision: "ALLOW" | "ESCALATE" | "DENY";
  readonly policy_version: number | null;
  readonly approvers?: readonly string[];
  readonly audit_event_id?: string;
  readonly wiki_context?: readonly string[];
  readonly reason?: Readonly<Record<string, unknown>>;
}

export class AgentsModule {
  public constructor(private readonly http: BrainHttp) {}

  /**
   * Register an agent for cross-tenant authorization.
   *
   * Implements `POST /agents/register` (operationId `registerAgent`).
   * Returns the persisted Agent record; the agent is in `pending_onchain`
   * until the BrainMCPAgentRegistry transaction confirms.
   *
   * @see https://docs.brain.fi/build/let-an-external-agent-in
   */
  public async register(opts: RegisterAgentInput): Promise<RegisterAgentResult> {
    const body: Record<string, unknown> = {
      onchain_address: opts.address,
      ...(opts.identityRoot !== undefined ? { identity_root: opts.identityRoot } : {}),
      ...(opts.mcpEndpoint !== undefined ? { mcp_endpoint: opts.mcpEndpoint } : {}),
      capabilities: opts.capabilities,
      ...(opts.metadataUri !== undefined ? { metadata_uri: opts.metadataUri } : {}),
      ...(opts.role !== undefined ? { role: opts.role } : {}),
      ...(opts.displayName !== undefined ? { display_name: opts.displayName } : {}),
    };
    return this.http.post<RegisterAgentResult>("/agents/register", body, {
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
  }

  /**
   * List configured agents for the current tenant.
   *
   * Implements `GET /agents` (operationId `listAgents`).
   */
  public async list(opts: ListAgentsOptions = {}): Promise<{ agents: Agent[] }> {
    return this.http.get<{ agents: Agent[] }>("/agents", {
      query: { tenantId: opts.tenantId },
    });
  }

  /**
   * Get an agent by id.
   *
   * Implements `GET /agents/{agent_id}` (operationId `getAgent`).
   */
  public async get(agentId: string): Promise<Agent> {
    return this.http.get<Agent>(`/agents/${encodeURIComponent(agentId)}`);
  }

  /**
   * Propose an action via an agent. The server attaches a PolicyDecision
   * and returns the resulting Action with its decision and approver
   * list.
   *
   * Implements `POST /agents/{agent_id}/propose` (operationId
   * `proposeAgentAction`).
   *
   * @see https://docs.brain.fi/sdks/agents-and-actions
   */
  public async propose(opts: ProposeOptions): Promise<ProposeResult> {
    return this.http.post<ProposeResult>(
      `/agents/${encodeURIComponent(opts.agentId)}/propose`,
      { tenantId: opts.tenantId, action: opts.action },
      {
        ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      },
    );
  }
}
