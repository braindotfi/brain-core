import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { components, paths } from "../generated/openapi.js";

export type AgentOutputProposal = components["schemas"]["AgentOutputProposal"];
export type ProposalDecision = components["schemas"]["ProposalDecision"];
export type ProposalDecisionResult = components["schemas"]["ProposalDecisionResult"];
export type ListProposalsParams = NonNullable<paths["/proposals"]["get"]["parameters"]["query"]>;

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

export class ProposalsResource {
  constructor(private readonly http: BrainHttpClient) {}

  async list(params: ListProposalsParams = {}): Promise<{
    proposals: AgentOutputProposal[];
    next_cursor: string | null;
  }> {
    const { data, error, response } = await this.http.GET("/proposals", {
      params: { query: params },
    });
    return unwrap(data, error, response.status);
  }

  async get(id: string): Promise<AgentOutputProposal> {
    const { data, error, response } = await this.http.GET("/proposals/{id}", {
      params: { path: { id } },
    });
    return unwrap(data, error, response.status);
  }

  async decide(id: string, decision: ProposalDecision): Promise<ProposalDecisionResult> {
    const { data, error, response } = await this.http.POST("/proposals/{id}/decide", {
      params: { path: { id } },
      body: { decision },
    });
    return unwrap(data, error, response.status);
  }
}
