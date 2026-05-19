import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, requireScope, type Scope } from "@brain/shared";
import type { WikiDeps } from "../deps.js";

const READ_SCOPE: Scope = "wiki:read";

export async function registerSchema(app: FastifyInstance, deps: WikiDeps): Promise<void> {
  app.get(
    "/wiki/schema",
    async (request: FastifyRequest<{ Querystring: { kind?: string } }>, reply) => {
      if (request.principal === undefined) {
        throw brainError("auth_token_missing", "principal required");
      }
      requireScope(request.principal.scopes, READ_SCOPE);

      const kind = request.query.kind;
      const out: Record<string, unknown> = {};

      if (kind === undefined) {
        for (const [k, s] of Object.entries(deps.schemas.entity)) {
          out[`entity/${k}`] = s;
        }
        for (const [k, s] of Object.entries(deps.schemas.relation)) {
          out[`relation/${k}`] = s;
        }
      } else if (kind.startsWith("entity/")) {
        const k = kind.slice("entity/".length) as keyof typeof deps.schemas.entity;
        const s = deps.schemas.entity[k];
        if (s === undefined) throw brainError("wiki_schema_validation_failed", "unknown kind");
        out[kind] = s;
      } else if (kind.startsWith("relation/")) {
        const k = kind.slice("relation/".length) as keyof typeof deps.schemas.relation;
        const s = deps.schemas.relation[k];
        if (s === undefined) throw brainError("wiki_schema_validation_failed", "unknown kind");
        out[kind] = s;
      } else {
        throw brainError(
          "request_params_invalid",
          "kind must be 'entity/<kind>' or 'relation/<kind>'",
        );
      }

      reply.status(200);
      return out;
    },
  );
}
