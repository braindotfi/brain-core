import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { components, paths } from "../generated/openapi.js";

type Agent = components["schemas"]["Agent"];

export type RegisterAgentBody = NonNullable<
  paths["/agents/register"]["post"]["requestBody"]
>["content"]["application/json"];

export type ListAgentActionsParams = NonNullable<
  paths["/agents/{agent_id}/actions"]["get"]["parameters"]["query"]
>;

export type AgentRouteRequest = NonNullable<
  paths["/agents/run"]["post"]["requestBody"]
>["content"]["application/json"];

type RoutingDecision = components["schemas"]["RoutingDecision"];
type AgentRunResult = components["schemas"]["AgentRunResult"];
type AgentRun = components["schemas"]["AgentRun"];

export type ListAgentRunsParams = NonNullable<paths["/agents/runs"]["get"]["parameters"]["query"]>;

export interface AgentActionsList {
  actions: Array<{
    proposalId: string | undefined;
    paymentIntentId: string | null | undefined;
    status: string | undefined;
    createdAt: string | undefined;
  }>;
}

export interface ProposeFromAgentResult {
  proposalId: string | undefined;
  policyDecisionId: string | undefined;
  status: string | undefined;
}

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

export class AgentsResource {
  constructor(private readonly http: BrainHttpClient) {}

  async list(): Promise<Agent[]> {
    const { data, error, response } = await this.http.GET("/agents");
    const body = unwrap(data, error, response.status);
    return body.agents ?? [];
  }

  async get(agentId: string): Promise<Agent> {
    const { data, error, response } = await this.http.GET("/agents/{agent_id}", {
      params: { path: { agent_id: agentId } },
    });
    return unwrap(data, error, response.status);
  }

  async register(body: RegisterAgentBody): Promise<Agent> {
    const { data, error, response } = await this.http.POST("/agents/register", {
      body,
    });
    return unwrap(data, error, response.status);
  }

  async listActions(
    agentId: string,
    params: ListAgentActionsParams = {},
  ): Promise<AgentActionsList> {
    const { data, error, response } = await this.http.GET("/agents/{agent_id}/actions", {
      params: { path: { agent_id: agentId }, query: params },
    });
    const body = unwrap(data, error, response.status);
    return {
      actions:
        body.actions?.map((a) => ({
          proposalId: a.proposal_id,
          paymentIntentId: a.payment_intent_id,
          status: a.status,
          createdAt: a.created_at,
        })) ?? [],
    };
  }

  async propose(agentId: string, action: Record<string, unknown>): Promise<ProposeFromAgentResult> {
    const { data, error, response } = await this.http.POST("/agents/{agent_id}/propose", {
      params: { path: { agent_id: agentId } },
      body: { action: action as Record<string, never> },
    });
    const body = unwrap(data, error, response.status);
    return {
      proposalId: body.proposal_id,
      policyDecisionId: body.policy_decision_id,
      status: body.status,
    };
  }

  // --- Agent Autonomy v3 (1a.6 / 1b.3 / 2.2) ---

  /** Routing decision only (no run). */
  async route(req: AgentRouteRequest): Promise<RoutingDecision> {
    const { data, error, response } = await this.http.POST("/agents/route", { body: req });
    return unwrap(data, error, response.status);
  }

  /** Route, resolve action, persist a run, and propose (shadow-aware). */
  async run(req: AgentRouteRequest): Promise<AgentRunResult> {
    const { data, error, response } = await this.http.POST("/agents/run", { body: req });
    return unwrap(data, error, response.status);
  }

  /** Enqueue an event-driven route/run job. */
  async enqueueEvent(req: AgentRouteRequest): Promise<{ job_id?: string; status?: string }> {
    const { data, error, response } = await this.http.POST("/agents/events", { body: req });
    return unwrap(data, error, response.status);
  }

  /** List agent runs. */
  async listRuns(params: ListAgentRunsParams = {}): Promise<AgentRun[]> {
    const { data, error, response } = await this.http.GET("/agents/runs", {
      params: { query: params },
    });
    const body = unwrap(data, error, response.status);
    return body.runs ?? [];
  }

  /** Agent run detail. */
  async getRun(runId: string): Promise<AgentRun> {
    const { data, error, response } = await this.http.GET("/agents/runs/{run_id}", {
      params: { path: { run_id: runId } },
    });
    return unwrap(data, error, response.status);
  }

  /** Structured reason + trace bundle for a run. */
  async why(runId: string): Promise<Record<string, unknown>> {
    const { data, error, response } = await this.http.GET("/agents/runs/{run_id}/why", {
      params: { path: { run_id: runId } },
    });
    return unwrap(data, error, response.status) as Record<string, unknown>;
  }

  /** Routing decision detail. */
  async getRoutingDecision(id: string): Promise<Record<string, unknown>> {
    const { data, error, response } = await this.http.GET("/agents/routing-decisions/{id}", {
      params: { path: { id } },
    });
    return unwrap(data, error, response.status) as Record<string, unknown>;
  }

  /** Kill-switch: pause an agent's in-flight intents and quarantine it. */
  async halt(
    agentId: string,
  ): Promise<{ agent_id?: string; paused?: string[]; quarantined?: boolean }> {
    const { data, error, response } = await this.http.POST("/agents/{agent_id}/halt", {
      params: { path: { agent_id: agentId } },
    });
    return unwrap(data, error, response.status);
  }

  /** Emergency-stop every agent in a category. */
  async haltCategory(
    category: "business" | "consumer" | "agnostic",
  ): Promise<Record<string, unknown>> {
    const { data, error, response } = await this.http.POST("/agents/halt-category", {
      body: { category },
    });
    return unwrap(data, error, response.status) as Record<string, unknown>;
  }
}
