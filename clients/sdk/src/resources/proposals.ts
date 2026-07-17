import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { components, paths } from "../generated/openapi.js";

type AgentProposal = components["schemas"]["AgentProposal"];
type AgentProposalSummary = components["schemas"]["AgentProposalSummary"];

export type ListProposalsParams = NonNullable<paths["/proposals"]["get"]["parameters"]["query"]>;

export type DecideProposalBody = NonNullable<
  paths["/proposals/{id}/decide"]["post"]["requestBody"]
>["content"]["application/json"];

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

export class ProposalsResource {
  constructor(private readonly http: BrainHttpClient) {}

  async list(params: ListProposalsParams = {}): Promise<AgentProposalSummary[]> {
    const { data, error, response } = await this.http.GET("/proposals", {
      params: { query: params },
    });
    const body = unwrap(data, error, response.status);
    return body.proposals ?? [];
  }

  async get(id: string): Promise<AgentProposal> {
    const { data, error, response } = await this.http.GET("/proposals/{id}", {
      params: { path: { id } },
    });
    return unwrap(data, error, response.status);
  }

  async decide(id: string, body: DecideProposalBody): Promise<AgentProposal> {
    const { data, error, response } = await this.http.POST("/proposals/{id}/decide", {
      params: { path: { id } },
      body,
    });
    return unwrap(data, error, response.status);
  }
}
