/**
 * Brain runtime config.
 *
 * Every service consumes its config through this module. All values come from
 * the process environment — not from files, not from hardcoded defaults at the
 * call site. Azure Key Vault supplies production values at container start
 * (§10.4). Local dev reads from `.env` or shell exports.
 *
 * Unknown or malformed env values fail fast at boot. A Brain service that
 * started successfully is guaranteed to have a well-typed config.
 */

import { z } from "zod";

const envSchema = z.object({
  // ---- Identity & environment ----
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  SERVICE_NAME: z.string().min(1).default("brain-unknown"),
  SERVICE_VERSION: z.string().default("0.0.0-dev"),

  // ---- Postgres ----
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // ---- Redis ----
  REDIS_URL: z.string().url(),

  // ---- Auth ----
  /** JWKS endpoint for Brain's auth service (§3.1). */
  AUTH_JWKS_URL: z.string().url(),
  AUTH_ISSUER: z.string().url().default("https://auth.brain.fi"),
  AUTH_AUDIENCE: z.string().default("brain-api"),
  /** Acceptable clock skew when verifying exp/iat. Keep small. */
  AUTH_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().nonnegative().default(5),

  // ---- Observability ----
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  LOG_PRETTY: z.coerce.boolean().default(false),
  /** DogStatsD UDP host:port. Empty disables metric emission (unit tests). */
  DOGSTATSD_HOST: z.string().default("127.0.0.1"),
  DOGSTATSD_PORT: z.coerce.number().int().positive().default(8125),
  DOGSTATSD_PREFIX: z.string().default("brain."),
  /** OTLP endpoint for traces. Empty disables export (unit tests). */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAMESPACE: z.string().default("brain"),

  // ---- Idempotency ----
  /** TTL for stored idempotency responses, §5.1. */
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(24 * 60 * 60),

  // ---- Limits ----
  REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(52_428_800), // 50 MiB cap
});

export type BrainConfig = z.infer<typeof envSchema>;

/**
 * Parse and validate an env-like record. Factored out so tests can feed in
 * fixtures without touching process.env.
 */
export function parseConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BrainConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid Brain configuration:\n${issues}`);
  }
  return result.data;
}

/**
 * Cached config lazily initialized from process.env.
 * Tests should call `parseConfig(fixture)` directly rather than relying on
 * the cache.
 */
let cached: BrainConfig | undefined;
export function loadConfig(): BrainConfig {
  if (cached === undefined) {
    cached = parseConfig();
  }
  return cached;
}

/** For tests only. Resets the cached config so a subsequent `loadConfig` re-reads env. */
export function _resetConfigForTests(): void {
  cached = undefined;
}
