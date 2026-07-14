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

/**
 * Optional non-empty string env var that tolerates empty values as "absent".
 *
 * `optionalNonEmptyString()` rejects an empty string because the optional
 * check only fires for `undefined`. Shells routinely export env vars as empty
 * strings (e.g. `export ANTHROPIC_API_KEY=` in a script that doesn't have the
 * secret). Treating empty as undefined matches the operator intuition and
 * keeps `loadConfig()` stable across shell states.
 */
function optionalNonEmptyString() {
  return z.preprocess(
    (v) => (typeof v === "string" && v.length === 0 ? undefined : v),
    z.string().min(1).optional(),
  );
}

const envSchema = z.object({
  // ---- Identity & environment ----
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  SERVICE_NAME: z.string().min(1).default("brain-unknown"),
  SERVICE_VERSION: z.string().default("0.0.0-dev"),
  PORT: z.coerce.number().int().positive().default(3000),

  // ---- Process role (worker/process separation) ----
  // One image, role via env. BRAIN_HTTP_ENABLED gates the /v1 API surface;
  // BRAIN_WORKERS selects which background-worker groups this process runs
  // ("all" | "none" | CSV of groups, e.g. "raw,canonical"). Defaults reproduce
  // the all-in-one process. See services/api/src/composition/process-roles.ts.
  BRAIN_HTTP_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  BRAIN_WORKERS: z.string().min(1).default("all"),

  // ---- Postgres ----
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // H-14: the Wiki layer connects with this URL as the read-only
  // `brain_wiki_reader` role (SELECT anywhere; write only wiki_* tables). When
  // unset the Wiki falls back to DATABASE_URL (dev/test) with a boot warning.
  BRAIN_WIKI_DB_URL: z.string().url().optional(),
  // Least-privilege cross-tenant role URLs (replace the single broad
  // DATABASE_PRIVILEGED_URL). Each connects as its own BYPASSRLS role scoped to
  // one layer's tables (infra/db-roles.sql §4). In production all eight are
  // required (db-isolation.ts fence); when unset each falls back to DATABASE_URL
  // with a boot warning — safe in dev/testnet where the role model is not applied.
  BRAIN_RAW_WORKER_DB_URL: z.string().url().optional(),
  BRAIN_CANONICAL_PROJECTOR_DB_URL: z.string().url().optional(),
  BRAIN_LEDGER_PROJECTOR_DB_URL: z.string().url().optional(),
  BRAIN_EXECUTION_WORKER_DB_URL: z.string().url().optional(),
  BRAIN_AUDIT_VERIFIER_DB_URL: z.string().url().optional(),
  BRAIN_AUDIT_PUBLISHER_DB_URL: z.string().url().optional(),
  BRAIN_RESOLVER_DB_URL: z.string().url().optional(),
  BRAIN_TENANT_DELETION_DB_URL: z.string().url().optional(),
  BRAIN_SURFACE_GATEWAY_DB_URL: z.string().url().optional(),

  // ---- Redis ----
  REDIS_URL: z.string().url(),

  // ---- Auth ----
  /** JWKS endpoint for Brain's auth service (§3.1). */
  AUTH_JWKS_URL: z.string().url(),
  AUTH_ISSUER: z.string().url().default("https://auth.brain.fi"),
  AUTH_AUDIENCE: z.string().default("brain-api"),
  /** Acceptable clock skew when verifying exp/iat. Keep small. */
  AUTH_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().nonnegative().default(5),
  /**
   * Shared platform BFF credential for production tenant creation, session
   * exchange, and invite consumption. Routes compare it in constant time.
   */
  BRAIN_PLATFORM_SERVICE_SECRET: optionalNonEmptyString(),

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

  // ---- Surface gateway ----
  SLACK_ENABLED: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("false"),
  SLACK_SIGNING_SECRET: optionalNonEmptyString(),
  SLACK_BOT_TOKEN: optionalNonEmptyString(),
  SLACK_CLIENT_ID: optionalNonEmptyString(),
  SLACK_CLIENT_SECRET: optionalNonEmptyString(),
  SLACK_INSTALL_STATE_SECRET: optionalNonEmptyString(),
  TEAMS_ENABLED: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("false"),
  TEAMS_APP_ID: optionalNonEmptyString(),
  TEAMS_APP_PASSWORD: optionalNonEmptyString(),
  EMAIL_ENABLED: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("false"),
  EMAIL_APPROVAL_BASE_URL: optionalNonEmptyString(),
  EMAIL_TOKEN_SECRET: optionalNonEmptyString(),
  EMAIL_ENDPOINT: optionalNonEmptyString(),
  EMAIL_API_KEY: optionalNonEmptyString(),
  EMAIL_FROM: optionalNonEmptyString(),
  EMAIL_ESP_WEBHOOK_SECRET: optionalNonEmptyString(),
  EMAIL_DOMAIN_SPF_EXPECTED: optionalNonEmptyString(),
  EMAIL_DOMAIN_DKIM_SELECTOR: optionalNonEmptyString(),
  EMAIL_DOMAIN_DKIM_PUBLIC_KEY: optionalNonEmptyString(),
  BRAIN_SURFACE_SMOKE_ENABLED: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("false"),
  BRAIN_SURFACE_SMOKE_SECRET: optionalNonEmptyString(),

  // ---- CORS ----
  /** Comma-separated list of allowed origins. Use "*" only in local dev — never in staging/prod. */
  CORS_ALLOWED_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000"),

  // ---- LLM (OpenAI) ----
  OPENAI_API_KEY: optionalNonEmptyString(),
  WIKI_LLM_MODEL: z.string().default("gpt-4o-mini"),
  WIKI_EMBED_MODEL: z.string().default("text-embedding-3-small"),
  // P0.3: per-(tenant, principal) wiki annotation rate limit, events/hour.
  WIKI_ANNOTATION_RATE_PER_HOUR: z.coerce.number().int().positive().default(60),

  // ---- LLM (Anthropic — legacy / tests only) ----
  ANTHROPIC_API_KEY: optionalNonEmptyString(),

  // ---- Sandbox / demo mode ----
  /** Set to "true" to enable sandbox-friendly stub overrides (no live credentials required). */
  BRAIN_DEMO_MODE: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("false"),

  /**
   * Set to "true" to expose POST /v1/demo/provision-run — the BrainSaaS
   * "Brain Playground" fresh-tenant-per-run provisioner. Default OFF.
   *
   * The route mints a scoped JWT for a fresh demo tenant. The minted token
   * carries READ + PROPOSE scopes only; it does NOT include payment_intent:execute,
   * audit:admin, or policy:write (batch 10 C-1 hardening). Execution must still
   * go through a tenant principal via /v1/payment-intents/{id}/execute.
   *
   * Production safety: enabling this in production is fenced by
   * assertDemoProvisionFences. Set BRAIN_DEMO_PROVISION_TESTNET_ATTESTED="true"
   * to acknowledge that this stack is a testnet "prod" (Base Sepolia, sandbox
   * rails) rather than a live-money mainnet. Without that attestation, boot
   * fails when NODE_ENV=production AND BRAIN_DEMO_PROVISION_ENABLED=true.
   *
   * Auth: when the route is enabled, callers MUST send the
   * X-Demo-Provision-Auth header equal to BRAIN_DEMO_PROVISION_SECRET. The
   * route used to be skipAuth: true; that footgun is closed.
   */
  BRAIN_DEMO_PROVISION_ENABLED: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("false"),
  /**
   * Required when BRAIN_DEMO_PROVISION_ENABLED=true in NODE_ENV=production.
   * The operator's explicit attestation that this stack is a testnet "prod"
   * (Base Sepolia, sandbox rails, no live mainnet exposure). Without it, the
   * api refuses to start. Mirrors the BRAIN_ESCROW_AUDIT_APPROVED pattern.
   */
  BRAIN_DEMO_PROVISION_TESTNET_ATTESTED: z.enum(["true", "false"]).default("false"),
  /**
   * Shared-secret header value the api compares X-Demo-Provision-Auth against.
   * Required when BRAIN_DEMO_PROVISION_ENABLED=true. Loaded from Key Vault in
   * production. Without it, the route cannot register (the route handler
   * itself throws if env is missing at register time).
   */
  BRAIN_DEMO_PROVISION_SECRET: optionalNonEmptyString(),

  /**
   * ---- BFF service-token mint (per-user production tenants) ----
   *
   * POST /v1/auth/service-token lets a TRUSTED backend-for-frontend (e.g. the
   * Brain Finance / BrainMVB BFF) mint a scoped JWT for a STABLE per-user
   * tenant — the production counterpart to the demo-provision fence. Unlike
   * provision-run it does NOT seed demo business data: it materialises an empty
   * tenant + an active payment agent (idempotent on the caller-supplied
   * tenant_id, which the BFF persists per app-user) and mints a token.
   *
   * Scope ceiling (mirrors the demo fence): READ + PROPOSE + APPROVE only. The
   * minted token never carries payment_intent:execute, audit:admin, or
   * policy:write — real money movement / signing stays off this path.
   *
   * Auth: when enabled, callers MUST send X-Service-Token-Auth equal to
   * BRAIN_SERVICE_TOKEN_SECRET (constant-time compared). The box signing key
   * never leaves the box; the BFF holds only the shared secret.
   *
   * Production safety: like the demo fence, enabling this in
   * NODE_ENV=production requires BRAIN_SERVICE_TOKEN_TESTNET_ATTESTED="true"
   * (the route mints propose/approve-capable tokens). Fenced by
   * assertServiceTokenFences at boot.
   */
  BRAIN_SERVICE_TOKEN_ENABLED: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("false"),
  /**
   * Required when BRAIN_SERVICE_TOKEN_ENABLED=true in NODE_ENV=production.
   * Operator's explicit attestation that this stack is a testnet "prod"
   * (Base Sepolia, sandbox rails). Without it, the api refuses to start.
   * Mirrors BRAIN_DEMO_PROVISION_TESTNET_ATTESTED.
   */
  BRAIN_SERVICE_TOKEN_TESTNET_ATTESTED: z.enum(["true", "false"]).default("false"),
  /**
   * Shared-secret header value the api compares X-Service-Token-Auth against.
   * Required when BRAIN_SERVICE_TOKEN_ENABLED=true. Loaded from Key Vault in
   * production. Without it the boot fence refuses to start.
   */
  BRAIN_SERVICE_TOKEN_SECRET: optionalNonEmptyString(),

  /**
   * ---- Per-customer API-key auth (token-exchange model) ----
   *
   * Set to "true" to register POST /v1/auth/api-key (exchange a customer's
   * `brain_sk_...` key for a short-lived agent JWT) and the platform-secret
   * gated issue/revoke routes under /v1/tenants/:tenantId/api-keys. Unlike
   * BRAIN_SERVICE_TOKEN_ENABLED, keys are never self-minted: only an operator
   * holding BRAIN_PLATFORM_SERVICE_SECRET can issue or revoke one. Default
   * OFF — the routes are not registered unless this is enabled.
   */
  BRAIN_API_KEY_AUTH_ENABLED: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("false"),

  // ---- Self-serve onboarding (RFC 0002) ----
  /**
   * Set to "true" to expose the public self-serve signup surface
   * (POST /v1/signup, /v1/auth/verify-email). Default OFF — the routes are not
   * registered unless this is enabled. New tenants are sandbox-only regardless.
   */
  BRAIN_SELF_SERVE_SIGNUP: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("false"),

  // ---- Plaid (consumed by tools/plaid-sandbox and Raw webhook verifier) ----
  PLAID_CLIENT_ID: optionalNonEmptyString(),
  PLAID_SECRET: optionalNonEmptyString(),
  PLAID_ENV: z.enum(["sandbox", "development", "production"]).default("sandbox"),
  /**
   * Stripe webhook endpoint signing secret (whsec_...) for the
   * platform-level /raw/webhooks/stripe endpoint. Absent => the stripe
   * webhook path answers 501 and ingestion relies on the pull modality.
   */
  STRIPE_WEBHOOK_SECRET: optionalNonEmptyString(),

  // ---- MCP / on-chain ----
  RPC_URL: z.string().url().default("https://sepolia.base.org"),
  MCP_AGENT_REGISTRY_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default("0xcE7Ce9dd95c17E1F4E27D49249b6fdb015f3A7e0"),
  POLICY_REGISTRY_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default("0x683893ccd84d9a3487095d09fed324b6b8ea2501"),
  BRAIN_MCP_DEV_AUTH_BYPASS: z.coerce.boolean().default(false),
  /**
   * Per-tenant MCP rate limit: how many tool calls one tenant may make in a
   * sliding window before further calls are rejected with rate_limited.
   * Defaults aim at ~10 req/s per tenant; tune per launch.
   */
  BRAIN_MCP_TENANT_RATE_LIMIT: z.coerce.number().int().positive().default(600),
  BRAIN_MCP_TENANT_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  /**
   * Canonical public origin the MCP surface is reachable at (the host Caddy maps
   * onto `/v1/agents/mcp`). Advertised verbatim as the `resource` value of the
   * RFC 9728 OAuth protected-resource metadata document and embedded in the
   * `WWW-Authenticate: Bearer resource_metadata="…"` challenge on MCP 401s, so
   * MCP clients can discover the authorization server. Sandbox overrides this to
   * `https://mcp.brain.dev`.
   */
  MCP_PUBLIC_RESOURCE_URL: z.string().url().default("https://mcp.brain.fi"),

  // ---- Python agents service (brain-agents) ----
  /**
   * URL of the brain-agents service hosting the four Python reasoners. When
   * unset, the api uses the in-process default agent service. When set, every
   * call is HMAC-signed via the X-Brain-Auth header — boot fails closed in
   * production if BRAIN_AGENTS_INBOUND_SECRET is also unset.
   */
  RECONCILIATION_AGENT_URL: optionalNonEmptyString(),
  /**
   * URL of the brain-agents service endpoint for explicit document extraction
   * runs. When unset, /v1/raw/{raw_id}/extract returns 501.
   */
  DOCUMENT_EXTRACT_AGENT_URL: optionalNonEmptyString(),
  /**
   * Shared secret for the X-Brain-Auth HMAC sent to the brain-agents service.
   * The Python side verifies with the same secret (BRAIN_AGENTS_INBOUND_SECRET
   * env var on that service). Required in production when RECONCILIATION_AGENT_URL
   * is set; absence triggers a boot-time throw.
   */
  BRAIN_AGENTS_INBOUND_SECRET: optionalNonEmptyString(),

  // ---- On-chain rails (Base) ----
  // NOTE: `BASE_RPC_URL` is the rail RPC (spec called it BRAIN_BASE_RPC_URL;
  // the repo already had BASE_RPC_URL for the audit-anchor broadcaster, so the
  // H-06 rail reuses it rather than adding a parallel var).
  BRAIN_SESSION_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
  BASE_RPC_URL: z.string().url().optional(),
  /** Per-deployment BrainSmartAccount address for on-chain PaymentIntent dispatch. */
  BRAIN_ONCHAIN_SMART_ACCOUNT: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  /** 0x 32-byte policy version digest the session key was granted for. Defaults to zero bytes32. */
  BRAIN_ONCHAIN_POLICY_VERSION: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .default("0x" + "00".repeat(32)),
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
  /**
   * Storage backend. Use "azure" or "s3" in staging/production, "memory" in
   * local dev only. "s3" targets any S3-compatible store (AWS S3, MinIO,
   * LocalStack) and keeps a single-VM deploy free of an Azure dependency.
   */
  BLOB_BACKEND: z.enum(["azure", "s3", "memory"]).default("memory"),
  /** Azure container name or S3 bucket name. */
  BLOB_CONTAINER: z.string().default("brain-artifacts"),
  /** Azure storage account name (required when BLOB_BACKEND=azure). */
  AZURE_BLOB_ACCOUNT_NAME: z.string().optional(),
  /** Azure storage account key (required when BLOB_BACKEND=azure). */
  AZURE_BLOB_ACCOUNT_KEY: z.string().optional(),
  /**
   * S3 endpoint URL (required for non-AWS stores like MinIO/LocalStack, e.g.
   * http://minio:9000). Omit to use the AWS SDK's default regional endpoint.
   */
  S3_ENDPOINT: z.string().url().optional(),
  /** S3 region (e.g. us-east-1). MinIO ignores it but the SDK still requires one. */
  S3_REGION: z.string().optional(),
  /** S3 access key id (required when BLOB_BACKEND=s3 unless using an instance role). */
  S3_ACCESS_KEY_ID: z.string().optional(),
  /** S3 secret access key (pairs with S3_ACCESS_KEY_ID). */
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /**
   * Force path-style addressing (bucket in the path, not the host). Required by
   * MinIO and most non-AWS S3 stores; leave false for real AWS S3.
   */
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("false"),

  // ---- Source credential encryption ----
  /**
   * Base64-encoded 32-byte AES-256-GCM key used to encrypt Plaid access_tokens
   * and other per-source secrets at rest. Staging/dev: set this env var.
   * Production: key must come from Azure Key Vault (env-var path is a TODO).
   * Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  BRAIN_SOURCE_CREDENTIAL_KEY: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/)
    .optional(),
  /** Label for the current credential key — used for key-rotation tracking. */
  BRAIN_SOURCE_CREDENTIAL_KEY_ID: z.string().min(1).default("local-dev-v1"),
  /**
   * Production KMS path: name of the Azure Key Vault secret that holds the
   * base64-encoded credential key. When set alongside BRAIN_AZURE_KEY_VAULT_URL,
   * the boot path selects the Key Vault provider over the env-var path.
   */
  BRAIN_SOURCE_CREDENTIAL_KEY_VAULT_NAME: optionalNonEmptyString(),

  // ---- x402 settlement rail ----
  /** Coinbase/facilitator URL for the x402 HTTP settlement protocol. Presence enables X402BaseRail at boot. */
  BRAIN_X402_FACILITATOR_URL: z.string().url().optional(),
  /** USDC contract address on Base (or Base Sepolia for testnet). */
  BRAIN_X402_USDC_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  /** Base network identifier forwarded in x402 settlement requests. Defaults to "base-sepolia". */
  BRAIN_X402_NETWORK: z.string().default("base-sepolia"),

  // ---- Escrow rail (BrainEscrow) ----
  /** BrainEscrow contract address on Base Sepolia. Presence enables EscrowBaseRail at boot. */
  BRAIN_ESCROW_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  /**
   * Explicit operator attestation that the configured BRAIN_ESCROW_ADDRESS has
   * passed the external smart-contract audit (Task #37). Without "true" the api
   * refuses to boot when chainId === 8453 (Base mainnet) AND BRAIN_ESCROW_ADDRESS
   * is set. Set this only after the audit signs off and the address on chain is
   * the audited bytecode. Has no effect on Base Sepolia (84_532).
   *
   * DEPRECATED in favour of BRAIN_ESCROW_AUDIT_RECEIPT (a URL/filepath/hash
   * pointing at the audit report). Either signal currently satisfies the boot
   * fence; the receipt is preferred because it carries diligence metadata
   * (which report? which audited commit?) rather than a bare boolean.
   */
  BRAIN_ESCROW_AUDIT_APPROVED: z.enum(["true", "false"]).default("false"),
  /**
   * Audit receipt: URL, filepath, IPFS hash, or any non-empty identifier that
   * points at the external audit report for the configured BRAIN_ESCROW_ADDRESS.
   * Recommended format: an https URL to the audit report PDF + a `#commit=<sha>`
   * fragment identifying the audited commit. Format is operator-defined;
   * the boot fence only checks non-empty. The capability log surfaces the
   * receipt verbatim so the running process records what was attested.
   *
   * EITHER this OR BRAIN_ESCROW_AUDIT_APPROVED="true" satisfies the mainnet
   * boot fence. Set this in preference to the boolean; the boolean exists
   * for backwards compatibility during the transition.
   */
  BRAIN_ESCROW_AUDIT_RECEIPT: optionalNonEmptyString(),

  // ---- Reputation registry (BrainReputationRegistry) ----
  /** BrainReputationRegistry contract address. Presence wires resolveReputation into PolicyService. */
  BRAIN_REPUTATION_REGISTRY_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),

  // ---- Agent window spend (gate check 8.5) ----
  /** Trailing lookback window for agent cumulative spend enforcement. Defaults to 86400s (24h). */
  BRAIN_AGENT_WINDOW_LOOKBACK_SECONDS: z.coerce.number().int().positive().default(86_400),

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
