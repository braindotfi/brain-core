/**
 * @brain/shared — Brain shared primitives.
 *
 * Every Brain service (raw, wiki, policy, execution, audit, and the api
 * gateway itself) imports these primitives via `@brain/shared`. The
 * primitives enforce Brain's non-negotiable principles (§1) and the
 * cross-cutting conventions in §3 through §6 of Engineering Standards.
 *
 * This is the single entry point; consumers should never reach past it
 * (`@brain/shared/auth/jwt` and the like) except in tightly-scoped
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
export { JwtVerifier, projectPrincipal, verifyWithKey, type VerifyOptions } from "./auth/jwt.js";
export { JwtSigner, type SignOptions } from "./auth/signer.js";
export { hashPassword, verifyPassword, PasswordInputError } from "./auth/password.js";
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

// Rate limiting (P0.3) — Redis sorted-set sliding window.
export {
  RedisSlidingWindowRateLimiter,
  InMemorySlidingWindowRateLimiter,
  type SlidingWindowRateLimiter,
  type SlidingWindowOptions,
  type RateLimitDecision,
} from "./ratelimit/sliding-window.js";

// Audit (§1 principle 4)
export * from "./audit/types.js";
export * from "./audit/hash.js";
export { InMemoryAuditEmitter, PostgresAuditEmitter, type AuditEmitter } from "./audit/emitter.js";

// HTTP plumbing
export { default as requestIdPlugin, sanitizeRequestId } from "./http/request-id.js";
export { default as errorHandlerPlugin, mapError } from "./http/error-handler.js";
export * from "./http/context.js";

// Blob storage (§3 Layer 1)
export * from "./blob/types.js";
export { createBlobAdapter, type BlobBackend, type BlobFactoryConfig } from "./blob/factory.js";
export { S3BlobAdapter, type S3AdapterOptions } from "./blob/s3.js";
export { AzureBlobAdapter, type AzureAdapterOptions } from "./blob/azure.js";
export { MemoryBlobAdapter } from "./blob/memory.js";

// Background jobs (BullMQ on Redis — §2)
export * from "./queue/types.js";
export { createQueue, createWorker, redisConnectionFromUrl } from "./queue/factory.js";

// Content addressing
export { hashStream, teeSha256 } from "./hashing.js";

// Network safety (SSRF guard for operator-influenced fetches)
export { isPublicUrl, publicOnlyLookup, type PublicUrlOptions } from "./net/ssrf.js";
export {
  fetchPublicHttps,
  type FetchPublicOptions,
  type FetchedResource,
} from "./net/safe-fetch.js";

// Webhook verification (inbound Plaid) + outbound dispatcher
export { verifyPlaidWebhook, type PlaidVerifyOptions } from "./webhooks/plaid.js";
export {
  WebhookDispatcher,
  WebhookAuditEmitter,
  generateWebhookSecret,
  deliverWebhook,
  FORWARDED_EVENTS,
} from "./webhooks/outbound.js";
export {
  MAX_WEBHOOK_DELIVERY_ATTEMPTS,
  recordDeliveryFailure,
  clearDeadLetter,
  listDeadLetters,
  getReplayableDeadLetters,
  deleteDeadLetterById,
  incrementDeadLetterAttempt,
  nextAttemptDelaySeconds,
  getDueDeadLetters,
  type WebhookDeadLetterRow,
  type RecordDeliveryFailureInput,
  type DueDeadLetter,
  type RawQueryClient,
} from "./webhooks/dead-letters.js";

// LLM + embeddings (§2 stack: Claude + OpenAI)
export * from "./llm/types.js";
export { AnthropicAdapter, type AnthropicAdapterOptions } from "./llm/anthropic.js";
export {
  OpenAICompletionAdapter,
  OpenAIEmbeddingAdapter,
  type OpenAIAdapterOptions,
  type OpenAIEmbeddingOptions,
} from "./llm/openai.js";
export {
  RecordedLlmAdapter,
  RecordedEmbeddingAdapter,
  DeterministicEmbeddingAdapter,
  llmKey,
  embeddingKey,
  type LlmRecording,
  type EmbeddingRecording,
} from "./llm/recorded.js";

// Layer-boundary contracts (v0.3 six-layer model).
// Every cross-service interface lives here as a type-only export.
export * from "./contracts/index.js";

// §6 pre-execution gate (v0.3 / Phase 4). Deterministic 13-step gate
// every PaymentIntent execution must pass.
export * from "./gate/index.js";

// Agent primitives (capability hashing, execution-mode resolution).
export * from "./agents/index.js";

// Domain-event vocabulary + routing enqueue (event-driven agent routing).
export * from "./events/triggers.js";
export * from "./events/types.js";
export * from "./events/bus.js";

// Credential encryption helpers (source secrets at rest).
export {
  encryptCredentials,
  decryptCredentials,
  decodeEnvCredentialKey,
} from "./crypto/aes-gcm.js";
