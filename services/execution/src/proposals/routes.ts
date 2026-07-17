/**
 * /proposals/* HTTP routes (BRAIN-CORE-ORCHESTRATION-GAP.md §3).
 *
 * Non-financial agent outputs (vendor risk, collections, treasury, etc.) that
 * a human reviews and decides on. Distinct surface from /payment-intents,
 * which is the gated money-movement path.
 *
 *   GET  /proposals               list
 *   GET  /proposals/{id}          detail
 *   POST /proposals/{id}/decide   record a human decision
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  isBrainId,
  requireScope,
  withTenantScope,
  type AuditEmitter,
  type Scope,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import type { ActorResolver } from "../members/ActorResolver.js";
import {
  decideAgentProposal,
  getAgentProposal,
  listAgentProposals,
  serializeAgentProposal,
  serializeAgentProposalSummary,
  type AgentProposalType,
} from "./repository.js";
import {
  nextStatus,
  type AgentProposalDecision,
  type AgentProposalStatus,
} from "./state-machine.js";

const SCOPE_READ: Scope = "execution:read";
const SCOPE_ADMIN: Scope = "execution:admin";

const VALID_STATUSES: ReadonlySet<AgentProposalStatus> = new Set([
  "needs_review",
  "acknowledged",
  "approved",
  "rejected",
  "undone_to_review",
]);

const VALID_TYPES: ReadonlySet<AgentProposalType> = new Set([
  "vendor_risk",
  "payment_batch",
  "collections",
  "treasury",
  "cash_forecast",
  "dispute",
  "compliance",
  "revenue_intel",
  "reconciliation",
  "subscription",
  "fraud_anomaly",
]);

const VALID_DECISIONS: ReadonlySet<AgentProposalDecision> = new Set([
  "approved",
  "rejected",
  "acknowledged",
  "undone_to_review",
]);

// Matches the decimal-string amount convention used elsewhere (e.g.
// shared/src/gate/gate.ts's AUTONOMOUS_CAP_DECIMAL) — no shared exported
// validator exists to reuse.
const DECIMAL_AMOUNT = /^\d+(\.\d+)?$/;

export interface ProposalRoutesDeps {
  pool: Pool;
  audit: AuditEmitter;
  actorResolver: ActorResolver;
}

interface DecideBody {
  decision?: string;
  edit?: ({ amount?: string } & Record<string, unknown>) | undefined;
  /** Ignored by design, mirrors payment-intents approve/reject. */
  actor_id?: unknown;
  actor?: unknown;
}

function assertCtx(request: FastifyRequest): ServiceCallContext {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  return {
    tenantId: request.principal.tenantId,
    actor: request.principal.id,
    requestId: request.id,
    principalType: request.principal.type,
    scopes: request.principal.scopes,
  };
}

export async function registerProposalRoutes(
  app: FastifyInstance,
  deps: ProposalRoutesDeps,
): Promise<void> {
  app.get(
    "/proposals",
    async (
      request: FastifyRequest<{
        Querystring: { status?: string; type?: string; limit?: string };
      }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_READ);
      const q = request.query;
      if (q.status !== undefined && !VALID_STATUSES.has(q.status as AgentProposalStatus)) {
        throw brainError("request_params_invalid", `unknown status: ${q.status}`);
      }
      if (q.type !== undefined && !VALID_TYPES.has(q.type as AgentProposalType)) {
        throw brainError("request_params_invalid", `unknown type: ${q.type}`);
      }
      const rows = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
        listAgentProposals(c, {
          ...(q.status !== undefined ? { status: q.status as AgentProposalStatus } : {}),
          ...(q.type !== undefined ? { type: q.type as AgentProposalType } : {}),
          ...(q.limit !== undefined ? { limit: Number.parseInt(q.limit, 10) } : {}),
        }),
      );
      reply.status(200);
      return { proposals: rows.map(serializeAgentProposalSummary) };
    },
  );

  app.get("/proposals/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, SCOPE_READ);
    if (!isBrainId(request.params.id, "agpr")) {
      throw brainError("request_params_invalid", "malformed agent_proposal id");
    }
    const row = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
      getAgentProposal(c, request.params.id),
    );
    if (row === null) {
      throw brainError("agent_proposal_not_found", "no such agent proposal");
    }
    reply.status(200);
    return serializeAgentProposal(row);
  });

  app.post(
    "/proposals/:id/decide",
    async (request: FastifyRequest<{ Params: { id: string }; Body: DecideBody }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_ADMIN);
      if (!isBrainId(request.params.id, "agpr")) {
        throw brainError("request_params_invalid", "malformed agent_proposal id");
      }
      const b = request.body ?? {};
      if (b.decision === undefined || !VALID_DECISIONS.has(b.decision as AgentProposalDecision)) {
        throw brainError(
          "request_body_invalid",
          "decision must be one of: " + [...VALID_DECISIONS].join(", "),
        );
      }
      const decision = b.decision as AgentProposalDecision;
      if (b.edit?.amount !== undefined && !DECIMAL_AMOUNT.test(b.edit.amount)) {
        throw brainError("request_body_invalid", "edit.amount must be a decimal string");
      }

      // Session identity only. The payload actor field is intentionally
      // ignored (mirrors PaymentIntentService.resolveApprovalActor).
      const actor = await deps.actorResolver.resolve({
        kind: "session",
        ctx,
        payloadActorId: b.actor_id ?? b.actor,
      });

      const row = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
        getAgentProposal(c, request.params.id),
      );
      if (row === null) {
        throw brainError("agent_proposal_not_found", "no such agent proposal");
      }
      const toStatus = nextStatus(row.status, decision, row.execution_mode, row.reversible);
      const updated = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
        decideAgentProposal(c, {
          id: row.id,
          expectedStatus: row.status,
          status: toStatus,
          decision,
          decidedBy: actor.memberId,
          ...(b.edit !== undefined ? { edit: b.edit } : {}),
        }),
      );
      await deps.audit.emit({
        tenantId: ctx.tenantId,
        layer: "agent",
        actor: actor.memberId,
        action: "proposal.decided",
        inputs: { type: row.type },
        outputs: { decision, proposal_id: row.id },
      });
      reply.status(200);
      return serializeAgentProposal(updated);
    },
  );
}
