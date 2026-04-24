/**
 * @brain/api/shared — Brain shared primitives.
 *
 * Every Brain service (raw, wiki, policy, execution, audit, and the api
 * gateway itself) imports these primitives via `@brain/api/shared`. The
 * primitives enforce Brain's non-negotiable principles (§1) and the
 * cross-cutting conventions in §3 through §6 of Engineering Standards.
 *
 * This is the single entry point; consumers should never reach past it
 * (`@brain/api/shared/auth/jwt` and the like) except in tightly-scoped
 * cases where a sub-module is genuinely the right dependency surface.
 */

// Core primitives
export * from "./errors.js";
export * from "./ids.js";
export * from "./config.js";

// Observability (§6)
export { createLogger, childFromContext } from "./logger.js";
export type { Logger, BrainLogContext } from "./logger.js";
export { createMetrics, MockMetrics } from "./metrics.js";
export type { MetricsEmitter, MetricTags } from "./metrics.js";
export * from "./tracing.js";

// Database (§1 principle 2)
export * from "./db/pool.js";
export * from "./db/tenant-scoped.js";

// Auth (§3)
export * from "./auth/principal.js";
export * from "./auth/scopes.js";
export {
  JwtVerifier,
  projectPrincipal,
  verifyWithKey,
  type VerifyOptions,
} from "./auth/jwt.js";
export {
  RedisRevocationStore,
  InMemoryRevocationStore,
  redisRevocationKey,
  type RevocationStore,
} from "./auth/revocation.js";
export { default as authPlugin, extractBearer } from "./auth/middleware.js";

// Idempotency (§5)
export {
  RedisIdempotencyStore,
  InMemoryIdempotencyStore,
  hashBody,
  idempotencyRedisKey,
  type IdempotencyStore,
  type IdempotencyLookup,
  type StoredResponse,
} from "./idempotency/store.js";
export { default as idempotencyPlugin } from "./idempotency/middleware.js";

// Audit (§1 principle 4)
export * from "./audit/types.js";
export * from "./audit/hash.js";
export {
  InMemoryAuditEmitter,
  PostgresAuditEmitter,
  type AuditEmitter,
} from "./audit/emitter.js";

// HTTP plumbing
export { default as requestIdPlugin, sanitizeRequestId } from "./http/request-id.js";
export { default as errorHandlerPlugin, mapError } from "./http/error-handler.js";
export * from "./http/context.js";
