import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, requireScope, type Scope, type ServiceCallContext } from "@brain/shared";
import type { Pool } from "pg";
import { getProposal, listProposals, parseListProposalsQuery } from "./read-model.js";
import {
  PROPOSAL_DECISIONS,
  ProposalDecisionService,
  type ProposalDecision,
  type ProposalDecisionServiceDeps,
} from "./decision-service.js";

const SCOPE_READ: Scope = "execution:read";

export interface ProposalReadRoutesDeps {
  pool: Pool;
  decisions?: ProposalDecisionService | ProposalDecisionServiceDeps;
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

export async function registerProposalReadRoutes(
  app: FastifyInstance,
  deps: ProposalReadRoutesDeps,
): Promise<void> {
  const decisions =
    deps.decisions instanceof ProposalDecisionService
      ? deps.decisions
      : deps.decisions !== undefined
        ? new ProposalDecisionService(deps.decisions)
        : null;

  app.get(
    "/proposals",
    async (
      request: FastifyRequest<{
        Querystring: {
          type?: string;
          status?: string;
          risk_band?: string;
          min_confidence?: string;
          limit?: string;
          cursor?: string;
        };
      }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_READ);
      const result = await listProposals(deps.pool, ctx, parseListProposalsQuery(request.query));
      reply.status(200);
      return result;
    },
  );

  app.get("/proposals/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, SCOPE_READ);
    const proposal = await getProposal(deps.pool, ctx, request.params.id);
    if (proposal === null) {
      throw brainError("execution_proposal_not_found", "no such proposal");
    }
    reply.status(200);
    return proposal;
  });

  app.post(
    "/proposals/:id/decide",
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { decision?: string; actor?: unknown; actor_id?: unknown };
      }>,
      reply,
    ) => {
      if (decisions === null) {
        throw brainError("dependency_unavailable", "proposal decision service is not configured");
      }
      const ctx = assertCtx(request);
      const decision = parseDecision(request.body?.decision);
      const result = await decisions.decide(ctx, request.params.id, decision);
      reply.status(200);
      return result;
    },
  );
}

function parseDecision(value: string | undefined): ProposalDecision {
  if (value === undefined) {
    throw brainError("request_body_invalid", "decision is required");
  }
  if (!PROPOSAL_DECISIONS.includes(value as ProposalDecision)) {
    throw brainError(
      "request_body_invalid",
      "decision must be approve, reject, acknowledge, or undo",
    );
  }
  return value as ProposalDecision;
}
