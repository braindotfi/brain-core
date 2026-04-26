import Fastify, { type FastifyInstance } from "fastify";
import {
  authPlugin,
  errorHandlerPlugin,
  requestIdPlugin,
  type JwtVerifier,
} from "@brain/api/shared";
import { registerEntity } from "./routes/entity.js";
import { registerSearch } from "./routes/search.js";
import { registerQuestion } from "./routes/question.js";
import { registerAnnotate } from "./routes/annotate.js";
import { registerSchema } from "./routes/schema.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { WikiPageService } from "./pages/WikiPageService.js";
import type { WikiDeps } from "./deps.js";

export interface BuildWikiAppOptions {
  deps: WikiDeps;
  jwtVerifier: JwtVerifier;
  logger?: ReturnType<typeof Fastify>["log"];
}

export async function buildWikiApp(opts: BuildWikiAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, { verifier: opts.jwtVerifier });

  app.get("/health", { config: { skipAuth: true } }, async () => ({ ok: true }));

  await registerEntity(app, opts.deps);
  await registerSearch(app, opts.deps);
  await registerQuestion(app, opts.deps);
  await registerAnnotate(app, opts.deps);
  await registerSchema(app, opts.deps);

  // v0.3 Phase 5: /memory/* (page rendering + lexical search).
  const pageService = new WikiPageService({
    pool: opts.deps.pool,
    audit: opts.deps.audit,
  });
  await registerMemoryRoutes(app, pageService);

  return app;
}
