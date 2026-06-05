/**
 * §Execution endpoints (proposal state machine §8.1, execution state machine
 * §8.2, agent registration §8.4). Despite the "v0.2" framing, most of this
 * surface is LIVE, not vestigial: `/execution/propose`, `/approve`,
 * `/escalate`, `/{execution_id}`, and `/agents*` are the generic action
 * proposal/approval API consumed by the published SDK `actions` resource and by
 * the Python reasoning agents (reconciliation / payment / anomaly call
 * `POST /v1/execution/propose`). Do not delete them without first providing a
 * v0.3 replacement and migrating both consumers.
 *
 * Two sub-routes ARE inert: `/execution/execute` is decommissioned (it bypassed
 * the §6 gate; money movement goes through `/payment-intents/*` /
 * `/actions/{id}/execute`), and `/execution/mcp` is a deprecated ping-only shim
 * superseded by `/v1/agents/mcp` (the real MCP server, services/mcp).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  isBrainId,
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
  insertProposal,
  listAgents,
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
  //
  // DECOMMISSIONED money path. This legacy v0.2 route dispatched a proposal
  // through a payment rail with NO §6 pre-execution gate — no policy decision,
  // no sanctions / balance / amount-limit checks, and no audit before/after
  // pair. Standards §6 ("no execution path may bypass the gate") and §9.5
  // ("financial actions use PaymentIntent, not Proposal") forbid that. Money
  // movement must go through POST /actions/{id}/execute (or the deprecated
  // /payment-intents/{id}/execute), both of which run the gate. We refuse here
  // rather than reproduce the boundary violation in new code (§14 rule 3).
  app.post(
    "/execution/execute",
    async (request: FastifyRequest<{ Body: { proposal_id?: string; rail?: string } }>) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, WRITE);
      throw brainError(
        "gate_no_policy_decision",
        "the legacy /execution/execute route is disabled because it bypasses the §6 pre-execution gate; execute money movement via POST /actions/{id}/execute, which runs the gate",
      );
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
        // Legacy v0.2 approval is satisfied by approver-id signature presence.
        // This path has no org-role membership model; tenant org roles + quorum
        // live in the PaymentIntent / ApprovalService path (the v0.3 approval
        // surface). New integrations approve via /payment-intents/*.
        const allSigned = Array.from(required).every((r) => signed.has(r));
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

  // POST /execution/mcp — DEPRECATED v0.2 back-compat shim.
  // The live MCP surface is POST /v1/agents/mcp (services/mcp): a JSON-RPC 2.0
  // server with 12 tools, 7 resource URIs, and 5 prompts. This legacy route
  // only ever answered `ping`; it is retained for the v0.3 transition window
  // (Brain_MVP_Architecture.md "Backward-compat note") and points callers at
  // the real surface rather than returning a bare "not implemented".
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
      if (method === "ping") {
        return reply.status(200).send({ ok: true });
      }
      throw brainError(
        "execution_agent_not_registered",
        `the /execution/mcp shim is deprecated and only retains 'ping'; ` +
          `use POST /v1/agents/mcp for the full MCP surface (requested method: ${method})`,
        { statusOverride: 501 },
      );
    },
  );
}

function requirePrincipal(request: FastifyRequest) {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  return request.principal;
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
