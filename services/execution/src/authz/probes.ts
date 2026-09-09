import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError } from "@brain/shared";
import { requirePaymentIntentApproveScope } from "../payment-intents/approve-scope.js";

function requirePrincipal(request: FastifyRequest): void {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
}

export async function registerAuthorizationProbeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/authz/probes/payment-intent-approve", async (request, reply) => {
    requirePrincipal(request);
    requirePaymentIntentApproveScope(request.principal!.scopes);
    reply.status(204).send();
  });
}
