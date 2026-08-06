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
        // Object.hasOwn, not an `=== undefined` check on the lookup: `kind` is
        // a raw query param, so `entity/constructor` (or toString, valueOf,
        // ...) resolves to an INHERITED Object.prototype member, passes a
        // not-undefined test, and gets written into the response. Own-property
        // membership is what "is this a registered schema kind" actually means.
        const k = kind.slice("entity/".length);
        if (!Object.hasOwn(deps.schemas.entity, k)) {
          throw brainError("wiki_schema_validation_failed", "unknown kind");
        }
        return Object.fromEntries([
          [kind, deps.schemas.entity[k as keyof typeof deps.schemas.entity]],
        ]);
      } else if (kind.startsWith("relation/")) {
        const k = kind.slice("relation/".length);
        if (!Object.hasOwn(deps.schemas.relation, k)) {
          throw brainError("wiki_schema_validation_failed", "unknown kind");
        }
        return Object.fromEntries([
          [kind, deps.schemas.relation[k as keyof typeof deps.schemas.relation]],
        ]);
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
