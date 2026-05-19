import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody, type Proposal } from "../errors.js";
import type { components, paths } from "../generated/openapi.js";

export type ProposeActionBody = NonNullable<
  paths["/execution/propose"]["post"]["requestBody"]
>["content"]["application/json"];

export interface ProposeActionParams {
  agentId: string;
  action: components["schemas"]["ProposedAction"];
  /**
   * Caller-supplied key for deduplication. Sent both in the JSON body
   * (per the spec) and as the `Idempotency-Key` HTTP header (industry
   * convention). The server may honor either.
   */
  idempotencyKey?: string;
}

export interface ExecuteProposalParams {
  proposalId: string;
  dryRun?: boolean;
}

export interface ApproveProposalParams {
  proposalId: string;
  approverNotes?: string;
}

export interface EscalateProposalParams {
  proposalId: string;
  reason: string;
}

export interface StartedExecution {
  executionId: string | undefined;
  status: "started" | undefined;
}

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

export class ActionsResource {
  constructor(private readonly http: BrainHttpClient) {}

  async propose(params: ProposeActionParams): Promise<Proposal> {
    const body: ProposeActionBody = {
      agent_id: params.agentId,
      action: params.action,
    };
    if (params.idempotencyKey !== undefined) {
      body.idempotency_key = params.idempotencyKey;
    }
    const headers: Record<string, string> = params.idempotencyKey
      ? { "Idempotency-Key": params.idempotencyKey }
      : {};
    const { data, error, response } = await this.http.POST("/execution/propose", { body, headers });
    return unwrap(data, error, response.status);
  }

  async execute(params: ExecuteProposalParams): Promise<StartedExecution> {
    const { data, error, response } = await this.http.POST("/execution/execute", {
      body: {
        proposal_id: params.proposalId,
        ...(params.dryRun !== undefined ? { dry_run: params.dryRun } : {}),
      },
    });
    const body = unwrap(data, error, response.status);
    return {
      executionId: body.execution_id,
      status: body.status,
    };
  }

  async approve(params: ApproveProposalParams): Promise<Proposal> {
    const body: { proposal_id: string; approver_notes?: string } = {
      proposal_id: params.proposalId,
    };
    if (params.approverNotes !== undefined) {
      body.approver_notes = params.approverNotes;
    }
    const { data, error, response } = await this.http.POST("/execution/approve", { body });
    return unwrap(data, error, response.status);
  }

  async escalate(params: EscalateProposalParams): Promise<void> {
    const { error, response } = await this.http.POST("/execution/escalate", {
      body: { proposal_id: params.proposalId, reason: params.reason },
    });
    if (error !== undefined) {
      throw new BrainAPIError((response as Response).status, error);
    }
  }

  async get(executionId: string): Promise<components["schemas"]["Execution"]> {
    const { data, error, response } = await this.http.GET("/execution/{execution_id}", {
      params: { path: { execution_id: executionId } },
    });
    return unwrap(data, error, response.status);
  }
}
