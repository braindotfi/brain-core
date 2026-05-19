/**
 * `brain.actions.*` — v0.3 user-facing write-path for financial actions.
 *
 * Wraps the /v1/actions/* HTTP family added in PLAN-FIRST #10. Source:
 * https://docs.brain.fi/api-reference/actions-api and
 * https://docs.brain.fi/sdks/agents-and-actions.
 *
 * @packageDocumentation
 */

import type { BrainHttp } from "../http/index.js";
import type { Components } from "../index.js";

type Schemas = Components["schemas"];
export type Action = Schemas["Action"];
export type ActionStatus = Schemas["ActionStatus"];
export type ActionRail = Schemas["ActionRail"];
export type ActionDecision = NonNullable<Action["decision"]>;

export interface CreateActionInput {
  readonly tenantId: string;
  readonly type: string;
  readonly agentId?: string;
  /** Convenience: when set, server resolves source/dest from the invoice. */
  readonly invoiceId?: string;
  readonly to?: { counterpartyId: string };
  readonly amount?: string;
  readonly currency?: string;
  readonly sourceAccountId?: string;
  readonly memo?: string;
  readonly evidenceIds?: readonly string[];
  /** Optional idempotency key override. */
  readonly idempotencyKey?: string;
}

export interface ListActionsOptions {
  readonly tenantId?: string;
  readonly agentId?: string;
  readonly status?: ActionStatus;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ApproveOptions {
  /** Approver identity reference (e.g. `"user_cfo"`, `"role:treasurer"`). */
  readonly as?: string;
  readonly approverRole?: string;
  /** EIP-712 signature for on-chain-registered policies. */
  readonly signature?: string;
  readonly idempotencyKey?: string;
}

export interface RejectOptions {
  readonly as?: string;
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

export interface ExecuteResult {
  readonly action_id: string;
  readonly execution_id: string;
  readonly rail: ActionRail;
  readonly status: "dispatched" | "in_flight";
}

export class ActionsModule {
  public constructor(private readonly http: BrainHttp) {}

  /**
   * Propose an action.
   *
   * Implements `POST /actions` (operationId `createAction`). The returned
   * `decision` field is one of `"ALLOW"`, `"ESCALATE"`, `"DENY"` per
   * docs/sdk-audit.md decision B (override).
   * @see https://docs.brain.fi/api-reference/actions-api
   */
  public async create(opts: CreateActionInput): Promise<Action> {
    const body: Record<string, unknown> = {
      tenantId: opts.tenantId,
      type: opts.type,
      ...(opts.agentId !== undefined ? { agent_id: opts.agentId } : {}),
      ...(opts.invoiceId !== undefined ? { invoiceId: opts.invoiceId } : {}),
      ...(opts.to !== undefined ? { to: { counterparty_id: opts.to.counterpartyId } } : {}),
      ...(opts.amount !== undefined ? { amount: opts.amount } : {}),
      ...(opts.currency !== undefined ? { currency: opts.currency } : {}),
      ...(opts.sourceAccountId !== undefined ? { source_account_id: opts.sourceAccountId } : {}),
      ...(opts.memo !== undefined ? { memo: opts.memo } : {}),
      ...(opts.evidenceIds !== undefined ? { evidence_ids: opts.evidenceIds } : {}),
    };
    return this.http.post<Action>("/actions", body, {
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
  }

  /**
   * List actions.
   *
   * Implements `GET /actions` (operationId `listActions`).
   */
  public async list(
    opts: ListActionsOptions = {},
  ): Promise<{ data: Action[]; next_cursor: string | null }> {
    return this.http.get<{ data: Action[]; next_cursor: string | null }>("/actions", {
      query: {
        tenantId: opts.tenantId,
        agent_id: opts.agentId,
        status: opts.status,
        from: opts.from,
        to: opts.to,
        limit: opts.limit,
        cursor: opts.cursor,
      },
    });
  }

  /**
   * Get a single action with its PolicyDecision + audit trail.
   *
   * Implements `GET /actions/{action_id}` (operationId `getAction`).
   */
  public async get(actionId: string): Promise<Action> {
    return this.http.get<Action>(`/actions/${encodeURIComponent(actionId)}`);
  }

  /**
   * Cancel a proposed (or escalated, pre-approval) action.
   *
   * Implements `DELETE /actions/{action_id}` (operationId `cancelAction`).
   */
  public async cancel(actionId: string, opts: { idempotencyKey?: string } = {}): Promise<Action> {
    return this.http.del<Action>(
      `/actions/${encodeURIComponent(actionId)}`,
      opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {},
    );
  }

  /**
   * Sign an approval on an ESCALATE action.
   *
   * Implements `POST /actions/{action_id}/approve` (operationId
   * `approveAction`).
   */
  public async approve(actionId: string, opts: ApproveOptions = {}): Promise<Action> {
    const body: Record<string, unknown> = {
      ...(opts.as !== undefined ? { as: opts.as } : {}),
      ...(opts.approverRole !== undefined ? { approver_role: opts.approverRole } : {}),
      ...(opts.signature !== undefined ? { signature: opts.signature } : {}),
    };
    return this.http.post<Action>(
      `/actions/${encodeURIComponent(actionId)}/approve`,
      body,
      opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {},
    );
  }

  /**
   * Reject an action.
   *
   * Implements `POST /actions/{action_id}/reject` (operationId
   * `rejectAction`).
   */
  public async reject(actionId: string, opts: RejectOptions = {}): Promise<Action> {
    const body: Record<string, unknown> = {
      ...(opts.as !== undefined ? { as: opts.as } : {}),
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    };
    return this.http.post<Action>(
      `/actions/${encodeURIComponent(actionId)}/reject`,
      body,
      opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {},
    );
  }

  /**
   * Execute an approved action. Runs the §6 13-step pre-execution gate.
   *
   * Implements `POST /actions/{action_id}/execute` (operationId
   * `executeAction`).
   */
  public async execute(
    actionId: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<ExecuteResult> {
    return this.http.post<ExecuteResult>(
      `/actions/${encodeURIComponent(actionId)}/execute`,
      undefined,
      opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {},
    );
  }
}
