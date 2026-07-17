import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, requireScope, type Scope, type ServiceCallContext } from "@brain/shared";
import type { Pool } from "pg";
import { getProposal, listProposals, parseListProposalsQuery } from "./read-model.js";

const SCOPE_READ: Scope = "execution:read";

export interface ProposalReadRoutesDeps {
  pool: Pool;
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
}
