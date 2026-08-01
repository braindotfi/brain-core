import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  brainError,
  guardGroundedAnswer,
  requireScope,
  withTenantScope,
  type Scope,
} from "@brain/shared";

const READ_SCOPE: Scope = "wiki:read";

interface AssistantQuestionsDeps {
  pool: Pool;
  log?: Pick<FastifyBaseLogger, "warn">;
}

interface AssistantQuestionsQuery {
  limit?: string;
}

interface AssistantQuestionRow {
  id: string;
  question: string;
  answer: string | null;
  status: string;
  source: string | null;
  evidence_ids: string[] | null;
  metadata: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export async function registerAssistantQuestionsRoute(
  app: FastifyInstance,
  deps: AssistantQuestionsDeps,
): Promise<void> {
  app.get(
    "/assistant/questions",
    async (request: FastifyRequest<{ Querystring: AssistantQuestionsQuery }>, reply) => {
      if (request.principal === undefined) {
        throw brainError("auth_token_missing", "principal required");
      }
      requireScope(request.principal.scopes, READ_SCOPE);
      const limit = parseLimit(request.query.limit);

      try {
        const questions = await withTenantScope(
          deps.pool,
          request.principal.tenantId,
          async (c) => {
            const { rows } = await c.query<AssistantQuestionRow>(
              `SELECT id, question, answer, status, source, evidence_ids, metadata, created_at, updated_at
               FROM assistant_questions
              WHERE tenant_id = current_setting('app.tenant_id', true)
              ORDER BY created_at DESC, id DESC
              LIMIT $1`,
              [limit],
            );
            return rows.map(serializeQuestion);
          },
        );
        reply.status(200);
        return { questions };
      } catch (err) {
        if (isUndefinedTable(err)) {
          deps.log?.warn(
            {
              err,
              tenant_id: request.principal.tenantId,
              request_id: request.id,
            },
            "assistant_questions table missing; returning empty questions list",
          );
          reply.status(200);
          return { questions: [] };
        }
        throw err;
      }
    },
  );
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw brainError("request_params_invalid", "limit must be a positive integer");
  }
  return Math.min(parsed, 100);
}

function serializeQuestion(row: AssistantQuestionRow) {
  const guardedAnswer = row.answer === null ? null : guardGroundedAnswer(row.answer).answer;
  return {
    id: row.id,
    question: row.question,
    answer: guardedAnswer,
    status: row.status,
    source: row.source,
    evidence_ids: row.evidence_ids ?? [],
    metadata: row.metadata ?? {},
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "42P01"
  );
}
