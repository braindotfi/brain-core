/**
 * Raw service Fastify app factory.
 *
 * Exported as a function so tests can spin up an app with injected fakes.
 * Boot wiring (HTTP port, DB pool creation, config load) lives in index.ts.
 */

import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import {
  authPlugin,
  errorHandlerPlugin,
  idempotencyPlugin,
  requestIdPlugin,
  type IdempotencyStore,
  type JwtVerifier,
  type PlaidVerifyOptions,
} from "@brain/api/shared";
import { registerArtifact } from "./routes/artifact.js";
import { registerIngest } from "./routes/ingest.js";
import { registerParsed } from "./routes/parsed.js";
import { registerWebhook, type WebhookTenantResolver } from "./routes/webhook.js";
import type { RawDeps } from "./deps.js";

export interface BuildRawAppOptions {
  deps: RawDeps;
  jwtVerifier: JwtVerifier;
  idempotencyStore: IdempotencyStore;
  idempotencyTtlSeconds?: number;
  plaidVerify: PlaidVerifyOptions;
  resolveWebhookTenant: WebhookTenantResolver;
  logger?: ReturnType<typeof Fastify>["log"];
}

export async function buildRawApp(opts: BuildRawAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 55 * 1024 * 1024, // a little headroom above the 50 MiB artifact cap
    disableRequestLogging: false,
  });

  // §3.4: webhook bodies MUST be verifiable byte-for-byte. Register a raw
  // content-type parser for the webhooks path that preserves the buffer.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      // For non-webhook routes, parse JSON normally; for webhook routes we
      // leave it as a Buffer and route handlers JSON-parse inside adapter
      // logic. The simplest approach: attach the Buffer, but also try to
      // parse JSON for non-webhook callers. Since we can't easily know the
      // route here, we parse and stash the buffer.
      try {
        const parsed = body.length > 0 ? JSON.parse(body.toString("utf8")) : {};
        // Expose raw bytes for downstream sig verify via req.rawBody hack.
        // Typed as unknown because Fastify's types are strict on parser return.
        (parsed as Record<string, unknown>)["__rawBody"] = body;
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Webhook route needs raw bytes; register a second parser just for the
  // webhook routes' content-type marker. We use application/octet-stream +
  // direct Buffer capture when operators configure webhooks to send bytes.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // §413 row
      files: 1,
      fields: 16,
    },
  });
  await app.register(authPlugin, { verifier: opts.jwtVerifier });
  await app.register(idempotencyPlugin, {
    store: opts.idempotencyStore,
    ttlSeconds: opts.idempotencyTtlSeconds ?? 86400,
  });

  // Health check — no auth, no DB.
  app.get("/health", { config: { skipAuth: true } }, async () => ({ ok: true }));

  await registerIngest(app, opts.deps);
  await registerWebhook(app, opts.deps, {
    plaidVerify: opts.plaidVerify,
    resolveTenant: opts.resolveWebhookTenant,
  });
  await registerArtifact(app, opts.deps);
  await registerParsed(app, opts.deps);

  return app;
}

export interface RegisterRawPluginOptions {
  plaidVerify: PlaidVerifyOptions;
  resolveWebhookTenant: WebhookTenantResolver;
}

/**
 * Plugin-style registration for the composed single-process boot.
 *
 * Registers all Raw routes and content-type parsers on an already-configured
 * Fastify app. Shared plugins (auth, error handler, request-id) are NOT
 * registered here — they are registered once by main.ts.
 */
export async function registerRawPlugin(
  app: FastifyInstance,
  deps: RawDeps,
  opts: RegisterRawPluginOptions,
): Promise<void> {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req: unknown, body: Buffer, done: (err: Error | null, body?: unknown) => void) => {
      try {
        const parsed =
          body.length > 0 ? (JSON.parse(body.toString("utf8")) as Record<string, unknown>) : {};
        parsed["__rawBody"] = body;
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req: unknown, body: Buffer, done: (err: Error | null, body?: unknown) => void) =>
      done(null, body),
  );
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 16 } });
  await registerIngest(app, deps);
  await registerWebhook(app, deps, {
    plaidVerify: opts.plaidVerify,
    resolveTenant: opts.resolveWebhookTenant,
  });
  await registerArtifact(app, deps);
  await registerParsed(app, deps);
}
