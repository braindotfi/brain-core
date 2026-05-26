/**
 * Regression guard (fix/main-green): buildRawApp must accept a pre-built logger
 * instance. Fastify v5 rejects a logger *instance* passed to `logger`
 * (FST_ERR_LOG_INVALID_LOGGER_CONFIG) — it must go through `loggerInstance`.
 * The raw integration harness passes `Fastify().log`, which crashed CI's
 * main.yml the first time the integration test actually ran (DATABASE_URL set).
 *
 * Construction does not touch the DB, so a stub pool is sufficient here.
 */

import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { Pool } from "pg";
import {
  InMemoryAuditEmitter,
  InMemoryIdempotencyStore,
  JwtVerifier,
  MemoryBlobAdapter,
} from "@brain/shared";
import { buildRawApp, type BuildRawAppOptions } from "./server.js";

function baseOpts(): Omit<BuildRawAppOptions, "logger"> {
  return {
    deps: {
      pool: {} as unknown as Pool, // never queried during app construction
      blob: new MemoryBlobAdapter(),
      audit: new InMemoryAuditEmitter(),
    },
    jwtVerifier: new JwtVerifier({
      jwksUrl: "https://auth.brain.fi/.well-known/jwks.json",
      issuer: "https://auth.brain.fi",
      audience: "brain-api",
      clockToleranceSeconds: 5,
    }),
    idempotencyStore: new InMemoryIdempotencyStore(),
    plaidVerify: { keyResolver: async () => ({}) as never },
    resolveWebhookTenant: async () => "tnt_unit",
  };
}

describe("buildRawApp logger handling", () => {
  it("accepts a pre-built logger instance (no FST_ERR_LOG_INVALID_LOGGER_CONFIG)", async () => {
    const logger = Fastify().log; // a FastifyBaseLogger instance
    const app = await buildRawApp({ ...baseOpts(), logger });
    expect(app).toBeDefined();
    await app.close();
  });

  it("falls back to a logger config object when no instance is given", async () => {
    const app = await buildRawApp(baseOpts());
    expect(app).toBeDefined();
    await app.close();
  });
});
