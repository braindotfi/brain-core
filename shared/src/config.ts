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
  PORT: z.coerce.number().int().positive().default(3000),

  // ---- Postgres ----
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // H-14: the Wiki layer connects with this URL as the read-only
  // `brain_wiki_reader` role (SELECT anywhere; write only wiki_* tables). When
  // unset the Wiki falls back to DATABASE_URL (dev/test) with a boot warning.
  BRAIN_WIKI_DB_URL: z.string().url().optional(),

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
  IDEMPOTENCY_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60),

  // ---- Limits ----
  REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(52_428_800), // 50 MiB cap

  // ---- CORS ----
  /** Comma-separated list of allowed origins. Use "*" only in local dev — never in staging/prod. */
  CORS_ALLOWED_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000"),

  // ---- LLM (OpenAI) ----
  OPENAI_API_KEY: z.string().min(1).optional(),
  WIKI_LLM_MODEL: z.string().default("gpt-4o-mini"),
  WIKI_EMBED_MODEL: z.string().default("text-embedding-3-small"),
  // P0.3: per-(tenant, principal) wiki annotation rate limit, events/hour.
  WIKI_ANNOTATION_RATE_PER_HOUR: z.coerce.number().int().positive().default(60),

  // ---- LLM (Anthropic — legacy / tests only) ----
  ANTHROPIC_API_KEY: z.string().min(1).optional(),

  // ---- Sandbox / demo mode ----
  /** Set to "true" to enable sandbox-friendly stub overrides (no live credentials required). */
  BRAIN_DEMO_MODE: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("false"),

  // ---- Plaid (consumed by tools/plaid-sandbox and Raw webhook verifier) ----
  PLAID_CLIENT_ID: z.string().min(1).optional(),
  PLAID_SECRET: z.string().min(1).optional(),
  PLAID_ENV: z.enum(["sandbox", "development", "production"]).default("sandbox"),

  // ---- MCP / on-chain ----
  RPC_URL: z.string().url().default("https://sepolia.base.org"),
  MCP_AGENT_REGISTRY_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default("0xd1558828ef31630164aa8942dd41bc63a4d8bed7"),
  POLICY_REGISTRY_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default("0x683893ccd84d9a3487095d09fed324b6b8ea2501"),
  BRAIN_MCP_DEV_AUTH_BYPASS: z.coerce.boolean().default(false),

  // ---- On-chain rails (Base) ----
  // NOTE: `BASE_RPC_URL` is the rail RPC (spec called it BRAIN_BASE_RPC_URL;
  // the repo already had BASE_RPC_URL for the audit-anchor broadcaster, so the
  // H-06 rail reuses it rather than adding a parallel var).
  BRAIN_SESSION_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
  BASE_RPC_URL: z.string().url().optional(),
  /** Base chain id for the on-chain rail. 8453 mainnet / 84532 sepolia (default). */
  BRAIN_BASE_CHAIN_ID: z.coerce.number().int().positive().default(84_532),
  /**
   * H-06: Azure Key Vault URL holding the on-chain rail's signing key. The
   * viem Account proxies signing to Key Vault via managed identity — the raw
   * private key is never read into process memory. Unset disables the live
   * on-chain rail (dev/test fall back to the fail-closed stub).
   */
  BRAIN_AZURE_KEY_VAULT_URL: z.string().url().optional(),

  // ---- Audit anchor (Base Sepolia) ----
  AUDIT_PUBLISHER_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
  AUDIT_ANCHOR_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default("0xb900add824064098342c869ff83efdeb05eb95ce"),
  AUDIT_ANCHOR_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 1000),

  // ---- Blob storage ----
  /** Storage backend. Use "azure" in staging/production, "memory" in local dev only. */
  BLOB_BACKEND: z.enum(["azure", "s3", "memory"]).default("memory"),
  /** Azure container name or S3 bucket name. */
  BLOB_CONTAINER: z.string().default("brain-artifacts"),
  /** Azure storage account name (required when BLOB_BACKEND=azure). */
  AZURE_BLOB_ACCOUNT_NAME: z.string().optional(),
  /** Azure storage account key (required when BLOB_BACKEND=azure). */
  AZURE_BLOB_ACCOUNT_KEY: z.string().optional(),

  // ---- Agent service ----
  /** Base URL of the brain-agents FastAPI service. Required when running the agent layer. */
  AGENT_SERVICE_URL: z.string().url().optional(),
  /**
   * Intent-classifier strategy for the agent router (Phase 4 feature flag).
   * "rules" (default) keeps the deterministic token-overlap classifier.
   * "embedding" uses the embedding classifier with the rules classifier as a
   * fallback (paraphrase-aware). Requires an embedding adapter (OPENAI_API_KEY
   * for real embeddings; otherwise the deterministic test adapter is used).
   */
  AGENT_INTENT_CLASSIFIER: z.enum(["rules", "embedding"]).default("rules"),

  // ---- SIWX (agent onboarding) ----
  /** JWK JSON string used to sign SIWX JWTs. Required in production; demo mode uses its own key. */
  AUTH_SIGN_KEY: z.string().optional(),
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
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
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
