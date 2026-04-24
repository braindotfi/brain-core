import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  requireScope,
  withTenantScope,
  type Scope,
} from "@brain/api/shared";
import { askWiki } from "../question/orchestrator.js";
import type { WikiDeps } from "../deps.js";

const READ_SCOPE: Scope = "wiki:read";

interface QuestionBody {
  question?: string;
  as_of?: string;
  max_evidence_depth?: number;
}

export async function registerQuestion(app: FastifyInstance, deps: WikiDeps): Promise<void> {
  app.post(
    "/wiki/question",
    async (request: FastifyRequest, reply) => {
      if (request.principal === undefined) {
        throw brainError("auth_token_missing", "principal required");
      }
      requireScope(request.principal.scopes, READ_SCOPE);
      const body = (request.body ?? {}) as QuestionBody;

      const question = body.question;
      if (typeof question !== "string" || question.length === 0 || question.length > 2000) {
        throw brainError("request_body_invalid", "question is required (1-2000 chars)");
      }
      const asOf = parseAsOf(body.as_of);
      const depth = Math.min(body.max_evidence_depth ?? 3, 5);

      const result = await withTenantScope(deps.pool, request.principal.tenantId, async (client) =>
        askWiki(
          {
            client,
            llm: deps.llm,
            embed: deps.embed,
            redis: deps.redis,
            metrics: deps.metrics,
          },
          {
            question,
            asOf,
            maxEvidenceDepth: depth,
            tenantId: request.principal!.tenantId,
            model: deps.questionModel,
          },
        ),
      );

      await deps.audit.emit({
        tenantId: request.principal.tenantId,
        layer: "wiki",
        actor: request.principal.id,
        action: "wiki.question",
        inputs: {
          question_length: question.length,
          as_of: asOf?.toISOString() ?? null,
          max_evidence_depth: depth,
          model: deps.questionModel,
        },
        outputs: {
          evidence_count: result.evidence.length,
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
        },
      });

      reply.status(200);
      return {
        question,
        answer: result.answer,
        evidence: result.evidence,
        model: result.model,
        usage: result.usage,
      };
    },
  );
}

function parseAsOf(v: unknown): Date | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") {
    throw brainError("request_body_invalid", "as_of must be a string");
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw brainError("wiki_temporal_range_invalid", "as_of is not a valid ISO timestamp");
  }
  return d;
}
