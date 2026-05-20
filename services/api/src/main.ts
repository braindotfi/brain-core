/**
 * Brain API boot binary — `brain-server`.
 *
 * Composes all six service layers into a single-process Fastify app.
 * Shared plugins (auth, error handler, request-id, idempotency) are
 * registered ONCE on the root app; each service layer registers its
 * routes as a Fastify plugin on top.
 *
 * See docs/boot-binary-spec.md for architecture decisions and the full
 * layer mount map.
 */

import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import { Redis } from "ioredis";
import {
  authPlugin,
  errorHandlerPlugin,
  requestIdPlugin,
  idempotencyPlugin,
  JwtVerifier,
  JwtSigner,
  PostgresAuditEmitter,
  WebhookDispatcher,
  WebhookAuditEmitter,
  RedisIdempotencyStore,
  RedisRevocationStore,
  createLogger,
  createPool,
  MemoryBlobAdapter,
  MockMetrics,
  DeterministicEmbeddingAdapter,
  OpenAICompletionAdapter,
  OpenAIEmbeddingAdapter,
  RecordedLlmAdapter,
  loadConfig,
  brainError,
  withTenantScope,
  newTokenId,
  type IRawEvidenceService,
  type IWikiMemoryService,
  type ServiceCallContext,
  type RawIngestRequest,
  type RawIngestResult,
  type ParsedOutput,
  type WikiPage,
  type QuestionRequest,
  type QuestionAnswer,
  type AnnotationInput,
} from "@brain/shared";

import { registerSiwxRoutes, StubAgentRegistry } from "./auth/siwx.js";
import { createViemAnchorBroadcaster } from "./anchorBroadcaster.js";

import { registerRawPlugin, ingestOne, type RegisterRawPluginOptions } from "@brain/raw";

import { LedgerService, registerLedgerPlugin, startNormalizeWorker } from "@brain/ledger";

import { WikiPageService, registerWikiPlugin, loadRegistry, askWiki } from "@brain/wiki";

import { registerPolicyRoutes, PolicyService } from "@brain/policy";
import type { PolicyDeps } from "@brain/policy";

import {
  registerExecutionRoutes,
  registerPaymentIntentRoutes,
  ApprovalService,
  PaymentIntentService,
  defaultRails,
  findAgent,
} from "@brain/execution";
import type { ExecutionDeps } from "@brain/execution";

import { registerAuditRoutes, publishAnchor } from "@brain/audit";
import type { AuditDeps } from "@brain/audit";

import {
  sandboxEvaluatePaymentIntent,
  sandboxEvaluateLegacyPolicy,
  sandboxResolveAgent,
  sandboxResolvePrincipal,
  sandboxResolveRole,
  makeSandboxResolveAccount,
  makeSandboxResolveCounterparty,
} from "./sandbox/resolvers.js";

import { BrainMcpServer, FakeAuthVerifier, registerMcpRoute } from "@brain/mcp";

import type { LedgerDeps } from "@brain/ledger";
import type { WikiDeps } from "@brain/wiki";
import type { RawDeps } from "@brain/raw";
import type {
  GateAccount,
  GateAgent,
  GateCounterparty,
  GatePaymentIntent,
  GatePrincipal,
} from "@brain/shared";

// ---------------------------------------------------------------------------
// .env loader (optional — repo-root .env only)
// ---------------------------------------------------------------------------

try {
  // Node 20.12+ built-in. Silently skip if file not found or function absent.

  const loadEnv = (process as unknown as Record<string, unknown>)["loadEnvFile"] as
    | ((path: string) => void)
    | undefined;
  if (loadEnv !== undefined) {
    const path = new URL("../../../../.env", import.meta.url).pathname;
    loadEnv(path);
  }
} catch {
  // No .env file present — that is fine in CI / container environments.
}

// ---------------------------------------------------------------------------
// IRawEvidenceService adapter
//
// @brain/raw exports ingestOne (a standalone function) but the MCP server
// and other callers expect IRawEvidenceService (a service-shaped object).
// This adapter bridges them. Unimplemented methods throw stubs.
// TODO: wire signedUrl, listParsed, tombstone to the raw repository helpers.
// ---------------------------------------------------------------------------

function buildRawEvidenceService(deps: RawDeps): IRawEvidenceService {
  return {
    async ingest(ctx: ServiceCallContext, req: RawIngestRequest): Promise<RawIngestResult> {
      const result = await ingestOne(deps, {
        tenantId: ctx.tenantId,
        actor: ctx.actor,
        sourceType: req.sourceType,
        sourceRef: req.sourceRef,
        body: req.body,
        mimeType: req.mimeType,
      });
      return {
        rawId: result.rawId,
        sha256: result.sha256,
        bytes: result.bytes,
        sourceType: result.sourceType,
        ingestedAt: result.ingestedAt,
        deduplicated: result.deduplicated,
      };
    },
    async signedUrl(
      _ctx: ServiceCallContext,
      _rawId: string,
      _ttlSeconds: number,
    ): Promise<string> {
      // TODO: implement via blob.signedUrl + artifact repository lookup.
      throw brainError("internal_server_error", "signedUrl not yet wired in boot binary");
    },
    async listParsed(_ctx: ServiceCallContext, _rawId: string): Promise<ParsedOutput[]> {
      // TODO: implement via listParsedByArtifact from @brain/raw repository.
      throw brainError("internal_server_error", "listParsed not yet wired in boot binary");
    },
    async tombstone(_ctx: ServiceCallContext, _rawId: string): Promise<void> {
      // TODO: implement via tombstoneArtifact from @brain/raw repository.
      throw brainError("internal_server_error", "tombstone not yet wired in boot binary");
    },
  };
}

// ---------------------------------------------------------------------------
// IWikiMemoryService adapter
//
// The MCP server needs IWikiMemoryService. WikiPageService covers
// listPages / getPage / search / regenerate. The question path and annotate
// are stubbed pending LLM + write-through wiring.
// TODO: wire question to askWiki, wire annotate to the write-through path.
// ---------------------------------------------------------------------------

function buildWikiMemoryService(
  pageService: WikiPageService,
  wikiDeps: WikiDeps,
): IWikiMemoryService {
  return {
    async listPages(
      ctx: ServiceCallContext,
      f: { page_type?: WikiPage["page_type"]; q?: string; limit?: number },
    ) {
      return pageService.listPages(ctx, f);
    },
    async getPage(ctx: ServiceCallContext, slugOrId: string) {
      return pageService.getPage(ctx, slugOrId);
    },
    async regenerate(ctx: ServiceCallContext, slugOrId: string) {
      return pageService.regenerate(ctx, slugOrId);
    },
    async search(ctx: ServiceCallContext, q: string, limit: number) {
      return pageService.search(ctx, q, limit);
    },
    async question(ctx: ServiceCallContext, req: QuestionRequest): Promise<QuestionAnswer> {
      const result = await withTenantScope(wikiDeps.pool, ctx.tenantId, (client) =>
        askWiki(
          {
            client,
            llm: wikiDeps.llm,
            embed: wikiDeps.embed,
            redis: wikiDeps.redis,
            metrics: wikiDeps.metrics,
          },
          {
            question: req.question,
            asOf: req.asOf !== null ? new Date(req.asOf) : null,
            maxEvidenceDepth: req.maxEvidenceDepth,
            tenantId: ctx.tenantId,
            model: wikiDeps.questionModel,
          },
        ),
      );
      return {
        question: req.question,
        answer: result.answer,
        evidence: result.evidence,
        model: result.model,
        usage: result.usage,
        ...(result.cachedAt !== undefined ? { cachedAt: result.cachedAt } : {}),
      };
    },
    // TODO: wire to the annotate write-through path.
    async annotate(
      _ctx: ServiceCallContext,
      _input: AnnotationInput,
    ): Promise<{ annotation_id: string; raw_artifact_id: string }> {
      throw brainError("internal_server_error", "wiki.annotate not yet wired in boot binary");
    },
  };
}

// ---------------------------------------------------------------------------
// Stub hook factories — reduce repetition in ExecutionDeps / PaymentIntentDeps
// ---------------------------------------------------------------------------

function makeResolveAgent(
  pool: ReturnType<typeof createPool>,
): (ctx: ServiceCallContext, agentId: string) => Promise<GateAgent | null> {
  return async (ctx, agentId) => {
    const row = await withTenantScope(pool, ctx.tenantId, (c) => findAgent(c, agentId));
    if (row === null) return null;
    return {
      id: row.id,
      state: row.state,
      scope: { canExecutePayments: row.state === "active" && row.role === "payment" },
    };
  };
}

function makeResolveAccount(
  ledger: LedgerService,
): (ctx: ServiceCallContext, accountId: string) => Promise<GateAccount | null> {
  return async (ctx, accountId) => {
    const result = await ledger.getAccount(ctx, accountId);
    if (result === null) return null;
    return {
      id: result.account.id,
      status: result.account.status,
      currency: result.account.currency,
      available_balance:
        result.latest_balance !== null
          ? result.latest_balance.available_balance
          : result.account.available_balance,
    };
  };
}

function makeResolveCounterparty(
  ledger: LedgerService,
): (ctx: ServiceCallContext, counterpartyId: string) => Promise<GateCounterparty | null> {
  return async (ctx, counterpartyId) => {
    const cp = await ledger.findCounterpartyById(ctx, counterpartyId);
    if (cp === null) return null;
    return {
      id: cp.id,
      type: cp.type,
      risk_level: cp.risk_level ?? null,
      verified_status: cp.verified_status ?? null,
    };
  };
}

function resolvePrincipalFromCtx(ctx: ServiceCallContext): Promise<GatePrincipal> {
  return Promise.resolve({
    id: ctx.actor,
    type: ctx.principalType ?? "user",
    scopes: ctx.scopes !== undefined ? [...ctx.scopes] : [],
  });
}

function makeResolveRole(
  pool: ReturnType<typeof createPool>,
): (ctx: ServiceCallContext, principalId: string) => Promise<string | null> {
  return async (ctx, principalId) => {
    const row = await withTenantScope(pool, ctx.tenantId, (c) => findAgent(c, principalId));
    if (row !== null) return row.role;
    // TODO: users-role table not yet modeled — see audit §6 cross-cutting.
    return null;
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig();

  const log = createLogger({
    level: cfg.LOG_LEVEL,
    service: cfg.SERVICE_NAME,
    version: cfg.SERVICE_VERSION,
    pretty: cfg.LOG_PRETTY,
  });

  // -- shared infra ----------------------------------------------------
  const pool = createPool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.DATABASE_POOL_MAX,
    statementTimeoutMs: cfg.DATABASE_STATEMENT_TIMEOUT_MS,
    applicationName: cfg.SERVICE_NAME,
  });

  const redis = new Redis(cfg.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
  await redis.connect();

  const audit = new WebhookAuditEmitter(
    new PostgresAuditEmitter(pool),
    new WebhookDispatcher(pool),
  );

  if (cfg.BRAIN_DEMO_MODE && cfg.NODE_ENV === "production") {
    throw new Error("BRAIN_DEMO_MODE=true is not allowed in NODE_ENV=production");
  }

  // Single source of truth for the demo HS256 secret. Used by both JwtVerifier
  // (to accept demo tokens) and JwtSigner (to mint them). Having it in two
  // inline literals means a typo breaks verification silently.
  const DEMO_SIGN_SECRET = "brain-demo-mode-insecure-dev-only";
  const DEMO_GOLDEN_USER = "usr_01GOLDEN00000000000000000" as const;
  const DEMO_GOLDEN_TENANT = "tnt_01GOLDEN00000000000000000" as const;

  const jwtVerifier = new JwtVerifier({
    jwksUrl: cfg.AUTH_JWKS_URL,
    ...(cfg.BRAIN_DEMO_MODE ? { secret: DEMO_SIGN_SECRET } : {}),
    issuer: cfg.AUTH_ISSUER,
    audience: cfg.AUTH_AUDIENCE,
    clockToleranceSeconds: cfg.AUTH_CLOCK_TOLERANCE_SECONDS,
    revocation: new RedisRevocationStore(redis),
  });

  // -- blob adapter (MemoryBlobAdapter until Azure/S3 creds are set) ---
  // TODO: wire to createBlobAdapter with real creds from config.
  const blob = new MemoryBlobAdapter();

  // -- layer deps objects ---------------------------------------------
  const rawDeps: RawDeps = { pool, blob, audit };
  const ledgerDeps: LedgerDeps = { pool, audit };
  const ledgerService = new LedgerService(ledgerDeps);

  const schemaRegistry = await loadRegistry();
  const metrics = new MockMetrics();

  // Wiki LLM + embed adapters.
  // Priority: OPENAI_API_KEY (real) > BRAIN_DEMO_MODE (recorded fixture) > throw-stub.
  const llm =
    cfg.OPENAI_API_KEY !== undefined
      ? new OpenAICompletionAdapter({ apiKey: cfg.OPENAI_API_KEY })
      : cfg.BRAIN_DEMO_MODE
        ? new RecordedLlmAdapter([])
        : {
            complete: async (): Promise<never> => {
              throw brainError("internal_server_error", "LLM not configured — set OPENAI_API_KEY");
            },
          };

  const embed =
    cfg.OPENAI_API_KEY !== undefined
      ? new OpenAIEmbeddingAdapter({ apiKey: cfg.OPENAI_API_KEY })
      : new DeterministicEmbeddingAdapter();

  const wikiDeps: WikiDeps = {
    pool,
    redis,
    audit,
    llm,
    embed,
    schemas: schemaRegistry,
    metrics,
    questionModel: cfg.WIKI_LLM_MODEL,
  };

  const wikiPageService = new WikiPageService({ pool, audit, embed });
  const wikiService = buildWikiMemoryService(wikiPageService, wikiDeps);

  const policyDeps: PolicyDeps = {
    pool,
    audit,
    // Base Sepolia chain id.
    chainId: 84532,
    policyRegistryAddress: cfg.POLICY_REGISTRY_ADDRESS as `0x${string}`,
  };

  const policyService = new PolicyService({ pool, audit });

  const rawEvidenceService = buildRawEvidenceService(rawDeps);

  // Resolver hooks — sandbox replacements when BRAIN_DEMO_MODE is on.
  const resolveRole = cfg.BRAIN_DEMO_MODE ? sandboxResolveRole : makeResolveRole(pool);
  const resolveAgent = cfg.BRAIN_DEMO_MODE ? sandboxResolveAgent : makeResolveAgent(pool);
  const resolveAccount = cfg.BRAIN_DEMO_MODE
    ? makeSandboxResolveAccount(pool)
    : makeResolveAccount(ledgerService);
  const resolveCounterparty = cfg.BRAIN_DEMO_MODE
    ? makeSandboxResolveCounterparty(pool)
    : makeResolveCounterparty(ledgerService);
  const resolvePrincipal = cfg.BRAIN_DEMO_MODE ? sandboxResolvePrincipal : resolvePrincipalFromCtx;
  const evaluatePaymentIntent = cfg.BRAIN_DEMO_MODE
    ? sandboxEvaluatePaymentIntent
    : (ctx: ServiceCallContext, intent: GatePaymentIntent) =>
        policyService.evaluateForGate(ctx, intent);
  const evaluateLegacyPolicy = cfg.BRAIN_DEMO_MODE
    ? sandboxEvaluateLegacyPolicy
    : async (tenantId: string, action: Record<string, unknown>) =>
        policyService.evaluateLegacy({ tenantId, actor: "system" }, action);

  const approvalService = new ApprovalService({
    pool,
    audit,
    resolveRole,
  });

  const paymentIntentService = new PaymentIntentService({
    pool,
    audit,
    rails: defaultRails(),
    approvals: approvalService,
    resolveAgent,
    resolveAccount,
    resolveCounterparty,
    evaluatePolicy: evaluatePaymentIntent,
    resolvePrincipal,
  });

  const executionDeps: ExecutionDeps = {
    pool,
    audit,
    rails: defaultRails(),
    evaluatePolicy: evaluateLegacyPolicy,
    evaluatePaymentIntent,
    resolveAgent,
    resolveAccount,
    resolveCounterparty,
    resolvePrincipal,
    resolveRole,
  };

  const anchorBroadcaster =
    cfg.AUDIT_PUBLISHER_KEY !== undefined
      ? createViemAnchorBroadcaster({
          privateKey: cfg.AUDIT_PUBLISHER_KEY as `0x${string}`,
          contractAddress: cfg.AUDIT_ANCHOR_ADDRESS as `0x${string}`,
          rpcUrl: cfg.BASE_RPC_URL ?? cfg.RPC_URL,
        })
      : undefined;

  const auditDeps: AuditDeps = {
    pool,
    audit,
    ...(anchorBroadcaster !== undefined ? { broadcaster: anchorBroadcaster } : {}),
  };

  // -- MCP server -----------------------------------------------------
  // TODO: swap FakeAuthVerifier for McpAuthVerifier with a real onchain
  //       checker when BRAIN_MCP_DEV_AUTH_BYPASS is false.
  const mcpAuthVerifier = new FakeAuthVerifier({
    id: "agent_00000000000000000000000000",
    tenant_id: "tnt_00000000000000000000000000",
    state: "active",
    scope_hash: null,
    onchain_address: null,
    role: "dev",
  });

  const mcpServer = new BrainMcpServer({
    auth: mcpAuthVerifier,
    ledger: ledgerService,
    wiki: wikiService,
    raw: rawEvidenceService,
    paymentIntents: paymentIntentService,
    audit,
  });

  // -- Fastify root app -----------------------------------------------
  const app = Fastify({
    logger: true,
    bodyLimit: cfg.REQUEST_BODY_LIMIT_BYTES,
    disableRequestLogging: false,
    trustProxy: true,
  });

  // Security plugins registered before routes.
  const corsOrigins = cfg.CORS_ALLOWED_ORIGINS
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  await app.register(fastifyCors, { origin: corsOrigins, credentials: true });
  await app.register(fastifyHelmet, { contentSecurityPolicy: false });
  await app.register(fastifyRateLimit, { max: 300, timeWindow: "1 minute" });

  // Shared plugins registered ONCE.
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, { verifier: jwtVerifier });
  await app.register(idempotencyPlugin, {
    store: new RedisIdempotencyStore(redis),
    ttlSeconds: cfg.IDEMPOTENCY_TTL_SECONDS,
  });

  app.get("/health", { config: { skipAuth: true } }, async () => ({
    ok: true,
    version: cfg.SERVICE_VERSION,
    service: cfg.SERVICE_NAME,
  }));

  // Service layer route registrations — all under /v1 to match OpenAPI spec.
  // Raw: also registers content-type parsers + multipart inside registerRawPlugin.
  const rawOpts: RegisterRawPluginOptions = {
    plaidVerify: {
      // In production supply a real key resolver backed by Plaid JWKS.
      // In demo mode the sandbox CLI uses /raw/ingest (not the webhook route),
      // so this resolver is only reached if someone explicitly POSTs to
      // /raw/webhooks/plaid — it rejects with a clear error either way.
      keyResolver: cfg.BRAIN_DEMO_MODE
        ? async (_kid: string): Promise<never> => {
            throw brainError(
              "raw_webhook_signature_invalid",
              "Plaid webhook signing not configured — use /raw/ingest in demo mode",
            );
          }
        : async (): Promise<never> => {
            throw brainError("raw_webhook_signature_invalid", "Plaid key resolver not configured");
          },
      clockToleranceSeconds: 300,
    },
    resolveWebhookTenant: async (
      _provider: string,
      _body: Buffer,
      headers: Record<string, unknown>,
    ): Promise<string> => {
      // TODO: implement real tenant resolution from Plaid item_id lookup.
      const devTenantHeader = headers["x-dev-tenant-id"];
      if (typeof devTenantHeader === "string" && devTenantHeader.length > 0) {
        return devTenantHeader;
      }
      throw brainError("auth_tenant_mismatch", "cannot resolve webhook tenant — not configured");
    },
  };

  // Mount all service routes under /v1 to match Brain_API_Specification.yaml.
  await app.register(
    async (v1) => {
      await v1.register(async (child) => registerRawPlugin(child, rawDeps, rawOpts));
      await v1.register(async (child) => registerLedgerPlugin(child, ledgerDeps));
      await v1.register(async (child) => registerWikiPlugin(child, wikiDeps));
      await v1.register(async (child) => registerPolicyRoutes(child, policyDeps));
      await v1.register(async (child) => registerExecutionRoutes(child, executionDeps));
      await v1.register(async (child) => {
        // PaymentIntentService has its own approval sub-service; create a fresh
        // instance scoped to this plugin so it doesn't share mutable state.
        const piApprovals = new ApprovalService({
          pool,
          audit,
          resolveRole,
        });
        const piService = new PaymentIntentService({
          pool,
          audit,
          rails: defaultRails(),
          approvals: piApprovals,
          resolveAgent,
          resolveAccount,
          resolveCounterparty,
          evaluatePolicy: evaluatePaymentIntent,
          resolvePrincipal,
        });
        await registerPaymentIntentRoutes(child, piService);
      });
      await v1.register(async (child) => registerAuditRoutes(child, auditDeps));
      await v1.register(async (child) => registerMcpRoute(child, mcpServer));
      // SIWX (agent auth) — wired in demo mode only. Production wiring requires
      // an AUTH_SIGN_KEY config variable backed by Azure Key Vault (follow-up).
      if (cfg.BRAIN_DEMO_MODE) {
        const demoSigner = new JwtSigner({
          issuer: cfg.AUTH_ISSUER,
          audience: cfg.AUTH_AUDIENCE,
          key: {
            kty: "oct",
            k: Buffer.from(DEMO_SIGN_SECRET).toString("base64url"),
            alg: "HS256",
          },
          algorithm: "HS256",
        });
        await v1.register(async (child) =>
          registerSiwxRoutes(child, {
            signer: demoSigner,
            registry: new StubAgentRegistry(),
            redis,
            demoMode: true,
          }),
        );

        // GET /v1/demo/token — mints a short-lived read-heavy demo JWT for the
        // golden-path tenant. Scoped to the minimum needed for the quickstart;
        // audit:admin and payment_intent:execute are intentionally excluded.
        v1.get(
          "/demo/token",
          { config: { skipAuth: true, rateLimit: { max: 5, timeWindow: "1 minute" } } },
          async (_req, reply) => {
            const DEMO_TTL_S = 15 * 60; // 15 minutes
            const token = await demoSigner.sign({
              id: DEMO_GOLDEN_USER,
              type: "user",
              tenantId: DEMO_GOLDEN_TENANT,
              tokenId: newTokenId(),
              expiresAt: Math.floor(Date.now() / 1000) + DEMO_TTL_S,
              scopes: [
                "ledger:read",
                "wiki:read",
                "raw:read",
                "raw:write",
                "policy:read",
                "execution:read",
                "execution:propose",
                "payment_intent:propose",
                "payment_intent:approve",
                "audit:read",
              ],
            });
            return reply.send({
              token,
              tenant_id: DEMO_GOLDEN_TENANT,
              expires_in: DEMO_TTL_S,
            });
          },
        );
      }
    },
    { prefix: "/v1" },
  );

  // -- background workers ---------------------------------------------
  const normalizeWorker = startNormalizeWorker({ pool, audit });

  let anchorTimer: NodeJS.Timeout | undefined;
  let anchorShutdown = false;

  if (anchorBroadcaster !== undefined) {
    const intervalMs = cfg.AUDIT_ANCHOR_INTERVAL_MS;
    let anchorRunning = false;

    const runAnchor = async (): Promise<void> => {
      if (anchorRunning) return;
      anchorRunning = true;
      const now = new Date();
      const periodStart = new Date(now.getTime() - intervalMs);
      try {
        const res = await pool.query<{ tenant_id: string }>(
          "SELECT DISTINCT tenant_id FROM audit_events WHERE created_at >= $1",
          [periodStart],
        );
        for (const row of res.rows) {
          try {
            await publishAnchor(pool, anchorBroadcaster, {
              tenantId: row.tenant_id,
              periodStart,
              periodEnd: now,
            });
          } catch (err) {
            log.error({ err, tenantId: row.tenant_id }, "anchor publish failed");
          }
        }
      } catch (err) {
        log.error({ err }, "anchor tenant query failed");
      } finally {
        anchorRunning = false;
        if (!anchorShutdown) {
          anchorTimer = setTimeout(() => void runAnchor(), intervalMs);
        }
      }
    };

    anchorTimer = setTimeout(() => void runAnchor(), intervalMs);
    log.info({ intervalMs }, "anchor publisher started");
  }

  // -- listen ---------------------------------------------------------
  await app.listen({ host: "0.0.0.0", port: cfg.PORT });
  log.info({ port: cfg.PORT, version: cfg.SERVICE_VERSION }, "brain-server up");

  // -- graceful shutdown ----------------------------------------------
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutting down");
    anchorShutdown = true;
    if (anchorTimer !== undefined) clearTimeout(anchorTimer);
    normalizeWorker.stop();
    try {
      await app.close();
    } catch (err) {
      log.error({ err }, "app.close failed");
    }
    try {
      await pool.end();
    } catch (err) {
      log.error({ err }, "pool.end failed");
    }
    try {
      redis.disconnect();
    } catch (err) {
      log.error({ err }, "redis.disconnect failed");
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
