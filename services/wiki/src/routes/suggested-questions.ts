import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, requireScope, withTenantScope, type Scope } from "@brain/shared";
import { listSuggestedQuestions } from "../question/orchestrator.js";
import type { WikiDeps } from "../deps.js";

const READ_SCOPE: Scope = "wiki:read";

export async function registerSuggestedQuestions(
  app: FastifyInstance,
  deps: WikiDeps,
): Promise<void> {
  app.get("/wiki/suggested-questions", async (request: FastifyRequest) => {
    if (request.principal === undefined) {
      throw brainError("auth_token_missing", "principal required");
    }
    requireScope(request.principal.scopes, READ_SCOPE);

    const suggestions = await withTenantScope(
      deps.pool,
      request.principal.tenantId,
      async (client) => listSuggestedQuestions(client),
    );
    return {
      suggestions: suggestions.map((suggestion) => ({
        intent_id: suggestion.intentId,
        display_text: suggestion.displayText,
        usage_rank_score: suggestion.usageRankScore,
      })),
    };
  });
}
