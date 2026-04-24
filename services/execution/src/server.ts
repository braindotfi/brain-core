import Fastify, { type FastifyInstance } from "fastify";
import {
  authPlugin,
  errorHandlerPlugin,
  requestIdPlugin,
  type JwtVerifier,
} from "@brain/api/shared";
import { registerExecutionRoutes } from "./routes.js";
import type { ExecutionDeps } from "./deps.js";

export interface BuildExecutionAppOptions {
  deps: ExecutionDeps;
  jwtVerifier: JwtVerifier;
  logger?: ReturnType<typeof Fastify>["log"];
}

export async function buildExecutionApp(opts: BuildExecutionAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 1 * 1024 * 1024,
  });
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, { verifier: opts.jwtVerifier });

  app.get("/health", { config: { skipAuth: true } }, async () => ({ ok: true }));

  await registerExecutionRoutes(app, opts.deps);
  return app;
}
