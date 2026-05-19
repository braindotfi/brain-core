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
}
