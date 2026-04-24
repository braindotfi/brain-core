import Fastify, { type FastifyInstance } from "fastify";
import {
  authPlugin,
  errorHandlerPlugin,
  requestIdPlugin,
  type JwtVerifier,
} from "@brain/api/shared";
import { registerPolicyRoutes } from "./routes.js";
import type { PolicyDeps } from "./deps.js";

export interface BuildPolicyAppOptions {
  deps: PolicyDeps;
  jwtVerifier: JwtVerifier;
  logger?: ReturnType<typeof Fastify>["log"];
}

export async function buildPolicyApp(opts: BuildPolicyAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 512 * 1024, // policy docs are small
  });
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, { verifier: opts.jwtVerifier });

  app.get("/health", { config: { skipAuth: true } }, async () => ({ ok: true }));

  await registerPolicyRoutes(app, opts.deps);
  return app;
}
