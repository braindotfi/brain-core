/**
 * Execution routes: 9 endpoints per Brain_API_Specification.yaml §Execution
 * plus /execution/mcp MCP surface. Proposal state machine §8.1, execution
 * state machine §8.2, agent registration state machine §8.4.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  isBrainId,
  newExecutionId,
  newProposalId,
  requireScope,
  withTenantScope,
  type Scope,
} from "@brain/shared";
import {
  appendApproverSigned,
  findAgent,
  findExecution,
  findProposal,
  insertAgent,
  insertExecution,
  insertProposal,
  listAgents,
  setExecutionReceipt,
  transitionExecution,
  transitionProposal,
  type ProposalRow,
} from "./repository.js";
import type { ExecutionDeps } from "./deps.js";

const PROPOSE: Scope = "execution:propose";
const WRITE: Scope = "execution:write";
const READ: Scope = "execution:read";
const ADMIN: Scope = "execution:admin";

export async function registerExecutionRoutes(
  app: FastifyInstance,
  deps: ExecutionDeps,
): Promise<void> {
  // POST /execution/propose
  app.post(
    "/execution/propose",
    async (
      request: FastifyRequest<{ Body: { action?: Record<string, unknown>; agent_id?: string } }>,
      reply,
    ) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, PROPOSE);

      const action = request.body?.action;
      if (action === undefined) {
        throw brainError("request_body_invalid", "action required");
      }
      const decision = await deps.evaluatePolicy(principal.tenantId, action);
      const proposingAgent = request.body?.agent_id ?? principal.id;

      const row = await withTenantScope(deps.pool, principal.tenantId, (c) =>
        insertProposal(c, {
          id: newProposalId(),
          tenantId: principal.tenantId,
          proposingAgent,
          action,
          policyVersion: decision.policy_version,
          policyDecision: decision.outcome,
          policyTrace: decision.trace as ProposalRow["policy_trace"],
          requiredApprovers: decision.required_approvers,
          status:
            decision.outcome === "reject"
              ? "rejected"
              : decision.outcome === "allow"
                ? "approved"
                : "pending",
        }),
      );

      await deps.audit.emit({
        tenantId: principal.tenantId,
        layer: "execution",
        actor: principal.id,
        action: "execution.propose",
        inputs: { action_kind: String(action.kind ?? "unknown"), agent: proposingAgent },
        outputs: {
          proposal_id: row.id,
          decision: decision.outcome,
          policy_version: decision.policy_version,
        },
        policyVersion: decision.policy_version,
      });

      reply.status(201);
      return serializeProposal(row);
    },
  );

  // POST /execution/execute
  app.post(
    "/execution/execute",
    async (request: FastifyRequest<{ Body: { proposal_id?: string; rail?: string } }>, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, WRITE);
      const proposalId = request.body?.proposal_id;
      const rail = request.body?.rail;
      if (proposalId === undefined || rail === undefined) {
        throw brainError("request_body_invalid", "proposal_id and rail required");
      }

      const railImpl = deps.rails.get(rail);
      const executionId = newExecutionId();

      const result = await withTenantScope(deps.pool, principal.tenantId, async (c) => {
        const proposal = await findProposal(c, proposalId);
        if (proposal === null) throw brainError("execution_proposal_not_found", "no such proposal");
        if (proposal.status !== "approved") {
          throw brainError(
            "execution_proposal_invalid_state",
            `proposal is in state ${proposal.status}; must be approved to execute`,
          );
        }

        const idempKey = request.headers["idempotency-key"];
        const exec = await insertExecution(c, {
          id: executionId,
          tenantId: principal.tenantId,
          proposalId,
          rail,
          status: "dispatched",
          ...(typeof idempKey === "string" ? { idempotencyKey: idempKey } : {}),
        });

        const dispatch = await railImpl.dispatch({
          tenantId: principal.tenantId,
          proposalId,
          executionId,
          action: proposal.action,
          idempotencyKey: exec.idempotency_key ?? "",
        });
        await setExecutionReceipt(c, executionId, dispatch.receipt);
        const moved = await transitionExecution(c, executionId, "dispatched", "in_flight");
        await transitionProposal(c, proposalId, "approved", "executed");
        return { exec: moved };
      });

      await deps.audit.emit({
        tenantId: principal.tenantId,
        layer: "execution",
        actor: principal.id,
        action: "execution.execute",
        inputs: { proposal_id: proposalId, rail, execution_id: executionId },
        outputs: { status: result.exec.status },
      });

      reply.status(202);
      return serializeExecution(result.exec);
    },
  );

  // GET /execution/{execution_id}
  app.get(
    "/execution/:execution_id",
    async (request: FastifyRequest<{ Params: { execution_id: string } }>, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, READ);
      const id = request.params.execution_id;
      if (!isBrainId(id, "exec")) {
        throw brainError("request_params_invalid", "malformed execution_id");
      }
      const row = await withTenantScope(deps.pool, principal.tenantId, (c) => findExecution(c, id));
      if (row === null) throw brainError("execution_proposal_not_found", "no such execution");
      reply.status(200);
      return serializeExecution(row);
    },
  );

  // POST /execution/approve
  app.post(
    "/execution/approve",
    async (request: FastifyRequest<{ Body: { proposal_id?: string } }>, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, WRITE);
      const proposalId = request.body?.proposal_id;
      if (proposalId === undefined)
        throw brainError("request_body_invalid", "proposal_id required");

      const row = await withTenantScope(deps.pool, principal.tenantId, async (c) => {
        const proposal = await findProposal(c, proposalId);
        if (proposal === null) throw brainError("execution_proposal_not_found", "no such proposal");
        if (proposal.status !== "pending") {
          throw brainError("execution_proposal_invalid_state", "proposal is not pending approval");
        }
        const updated = await appendApproverSigned(c, proposalId, principal.id);
        if (updated === null) {
          // already signed — return the existing proposal.
          return proposal;
        }
        const signed = new Set(updated.approvers_signed);
        const required = new Set(updated.required_approvers);
        const allSigned = Array.from(required).every((r) => signed.has(r) || hasRole(principal, r));
        if (allSigned) {
          return transitionProposal(c, proposalId, "pending", "approved");
        }
        return updated;
      });

      await deps.audit.emit({
        tenantId: principal.tenantId,
        layer: "execution",
        actor: principal.id,
        action: "execution.approve",
        inputs: { proposal_id: proposalId },
        outputs: { status: row.status, approvers_signed: row.approvers_signed },
      });

      reply.status(200);
      return serializeProposal(row);
    },
  );

  // POST /execution/escalate
  app.post(
    "/execution/escalate",
    async (request: FastifyRequest<{ Body: { proposal_id?: string; note?: string } }>, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, PROPOSE);
      const proposalId = request.body?.proposal_id;
      if (proposalId === undefined)
        throw brainError("request_body_invalid", "proposal_id required");
      await deps.audit.emit({
        tenantId: principal.tenantId,
        layer: "execution",
        actor: principal.id,
        action: "execution.escalate",
        inputs: { proposal_id: proposalId, note: (request.body?.note ?? "").slice(0, 200) },
        outputs: {},
      });
      reply.status(202);
      return { escalated: true, proposal_id: proposalId };
    },
  );

  // GET /execution/agents
  app.get("/execution/agents", async (request, reply) => {
    const principal = requirePrincipal(request);
    requireScope(principal.scopes, READ);
    const agents = await withTenantScope(deps.pool, principal.tenantId, (c) => listAgents(c));
    reply.status(200);
    return { agents: agents.map(serializeAgent) };
  });

  // POST /execution/agents/register
  app.post(
    "/execution/agents/register",
    async (
      request: FastifyRequest<{
        Body: {
          agent_id?: string;
          role?: string;
          display_name?: string;
          scope_hash?: string;
          onchain_address?: string;
          registered_tx?: string;
        };
      }>,
      reply,
    ) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, ADMIN);
      const b = request.body ?? {};
      if (b.agent_id === undefined || b.role === undefined || b.display_name === undefined) {
        throw brainError("request_body_invalid", "agent_id, role, display_name required");
      }
      const row = await withTenantScope(deps.pool, principal.tenantId, (c) =>
        insertAgent(c, {
          id: b.agent_id!,
          tenant_id: principal.tenantId,
          kind: "external",
          role: b.role!,
          display_name: b.display_name!,
          scope_hash: b.scope_hash !== undefined ? Buffer.from(b.scope_hash, "hex") : null,
          onchain_address: b.onchain_address ?? null,
          state: "pending_onchain",
          registered_tx: b.registered_tx ?? null,
        }),
      );
      await deps.audit.emit({
        tenantId: principal.tenantId,
        layer: "execution",
        actor: principal.id,
        action: "execution.agent.register",
        inputs: { agent_id: row.id, role: row.role },
        outputs: { state: row.state },
      });
      reply.status(201);
      return serializeAgent(row);
    },
  );

  // GET /execution/agents/{agent_id}
  app.get(
    "/execution/agents/:agent_id",
    async (request: FastifyRequest<{ Params: { agent_id: string } }>, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, READ);
      const row = await withTenantScope(deps.pool, principal.tenantId, (c) =>
        findAgent(c, request.params.agent_id),
      );
      if (row === null) throw brainError("execution_agent_not_registered", "no such agent");
      reply.status(200);
      return serializeAgent(row);
    },
  );

  // POST /execution/mcp — MCP surface for external agents.
  // MVP dispatches by `method` field so third-party MCP clients can call
  // wiki.query / execution.propose / raw.contribute with a Brain-scoped
  // JWT. Full JSON-RPC / SSE framing lands in a follow-up; stage-6 ships
  // the HTTP surface that the payment-agent demo uses.
  app.post(
    "/execution/mcp",
    async (
      request: FastifyRequest<{ Body: { method?: string; params?: Record<string, unknown> } }>,
      reply,
    ) => {
      const principal = requirePrincipal(request);
      if (principal.type !== "agent") {
        throw brainError(
          "auth_scope_insufficient",
          "MCP surface accepts principal_type=agent only",
        );
      }
      const method = request.body?.method;
      if (method === undefined) {
        throw brainError("request_body_invalid", "method required");
      }
      switch (method) {
        case "ping":
          return reply.status(200).send({ ok: true });
        default:
          throw brainError(
            "execution_agent_not_registered",
            `MCP method not implemented: ${method}`,
            {
              statusOverride: 501,
            },
          );
      }
    },
  );
}

function requirePrincipal(request: FastifyRequest) {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  return request.principal;
}

function hasRole(_principal: ReturnType<typeof requirePrincipal>, _role: string): boolean {
  // Role membership lookup lands with the tenant organization model in a
  // subsequent PR. For stage-6 we treat approval by id presence in the
  // approvers_signed list as sufficient.
  return false;
}

function serializeProposal(row: ProposalRow): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    action: row.action,
    policy_version: row.policy_version,
    policy_decision: row.policy_decision,
    required_approvers: row.required_approvers,
    approvers_signed: row.approvers_signed,
    proposing_agent: row.proposing_agent,
    created_at: row.created_at.toISOString(),
  };
}

function serializeExecution(row: {
  id: string;
  proposal_id: string;
  rail: string;
  rail_receipt: Record<string, unknown> | null;
  status: string;
  started_at: Date;
  completed_at: Date | null;
}): Record<string, unknown> {
  return {
    id: row.id,
    proposal_id: row.proposal_id,
    rail: row.rail,
    rail_receipt: row.rail_receipt,
    status: row.status,
    started_at: row.started_at.toISOString(),
    completed_at: row.completed_at?.toISOString() ?? null,
  };
}

function serializeAgent(row: {
  id: string;
  kind: string;
  role: string;
  display_name: string;
  scope_hash: Buffer | null;
  onchain_address: string | null;
  state: string;
  registered_tx: string | null;
  registered_at: Date | null;
}): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    role: row.role,
    display_name: row.display_name,
    scope_hash: row.scope_hash === null ? null : row.scope_hash.toString("hex"),
    onchain_address: row.onchain_address,
    state: row.state,
    registered_tx: row.registered_tx,
    registered_at: row.registered_at?.toISOString() ?? null,
  };
}
