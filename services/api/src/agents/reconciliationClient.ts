/**
 * ReconciliationAgentClient — IAgentService implementation that delegates
 * `propose` to the Python reconciliation agent via HTTP.
 *
 * Only `propose` is used by the MCP layer (agent.action.propose tool).
 * All other IAgentService methods throw internal_server_error — they are not
 * surfaced through the MCP surface and are not wired here.
 */

import {
  brainError,
  type AgentRecord,
  type IAgentService,
  type ProposalInput,
  type ProposalRecord,
  type ServiceCallContext,
} from "@brain/shared";

export class ReconciliationAgentClient implements IAgentService {
  public constructor(private readonly baseUrl: string) {}

  public async propose(
    ctx: ServiceCallContext,
    agentId: string,
    input: ProposalInput,
  ): Promise<ProposalRecord> {
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/run/reconciliation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId,
          action: input.action,
          tenant_id: ctx.tenantId,
        }),
      });
    } catch (cause) {
      throw brainError("internal_server_error", "reconciliation agent unreachable", { cause });
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw brainError(
        "internal_server_error",
        `reconciliation agent returned ${String(resp.status)}: ${text}`,
      );
    }
    return (await resp.json()) as ProposalRecord;
  }

  // ---------------------------------------------------------------------------
  // Unimplemented stubs — not surfaced through the MCP layer.
  // ---------------------------------------------------------------------------

  public async list(_ctx: ServiceCallContext): Promise<AgentRecord[]> {
    throw brainError("internal_server_error", "ReconciliationAgentClient does not support list()");
  }

  public async get(_ctx: ServiceCallContext, _agentId: string): Promise<AgentRecord | null> {
    throw brainError("internal_server_error", "ReconciliationAgentClient does not support get()");
  }

  public async register(
    _ctx: ServiceCallContext,
    _input: Omit<AgentRecord, "state" | "registered_at">,
  ): Promise<AgentRecord> {
    throw brainError(
      "internal_server_error",
      "ReconciliationAgentClient does not support register()",
    );
  }

  public async listActions(
    _ctx: ServiceCallContext,
    _agentId: string,
    _limit: number,
  ): Promise<ProposalRecord[]> {
    throw brainError(
      "internal_server_error",
      "ReconciliationAgentClient does not support listActions()",
    );
  }

  public async approve(_ctx: ServiceCallContext, _proposalId: string): Promise<ProposalRecord> {
    throw brainError(
      "internal_server_error",
      "ReconciliationAgentClient does not support approve()",
    );
  }

  public async reject(
    _ctx: ServiceCallContext,
    _proposalId: string,
    _reason?: string,
  ): Promise<ProposalRecord> {
    throw brainError(
      "internal_server_error",
      "ReconciliationAgentClient does not support reject()",
    );
  }

  public async escalate(
    _ctx: ServiceCallContext,
    _proposalId: string,
    _note?: string,
  ): Promise<void> {
    throw brainError(
      "internal_server_error",
      "ReconciliationAgentClient does not support escalate()",
    );
  }
}
