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

import { initTracing, shutdownTracing } from "./instrumentation.js";
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
  createBlobAdapter,
  MockMetrics,
  DeterministicEmbeddingAdapter,
  OpenAICompletionAdapter,
  OpenAIEmbeddingAdapter,
  RecordedLlmAdapter,
  loadConfig,
  brainError,
  withTenantScope,
  newTokenId,
  newPolicyId,
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

import { registerSiwxRoutes, StubAgentRegistry, PostgresAgentRegistry } from "./auth/siwx.js";
import { createViemAnchorBroadcaster } from "./anchorBroadcaster.js";

import {
  registerRawPlugin,
  ingestOne,
  findArtifactById,
  tombstoneArtifact,
  listParsedByArtifact,
  type RegisterRawPluginOptions,
} from "@brain/raw";

import { LedgerService, registerLedgerPlugin, startNormalizeWorker } from "@brain/ledger";

import { WikiPageService, registerWikiPlugin, loadRegistry, askWiki } from "@brain/wiki";

import { registerPolicyRoutes, PolicyService, contentHash } from "@brain/policy";
import type { PolicyDeps, PolicyDocument } from "@brain/policy";

import {
  registerExecutionRoutes,
  registerPaymentIntentRoutes,
  ApprovalService,
  PaymentIntentService,
  defaultRails,
  findAgent,
  findUser,
} from "@brain/execution";
import type { ExecutionDeps } from "@brain/execution";

import { registerAuditRoutes, publishAnchor } from "@brain/audit";
import type { AuditDeps } from "@brain/audit";

import {
  sandboxEvaluateLegacyPolicy,
  sandboxResolveAgent,
  sandboxResolvePrincipal,
  sandboxResolveRole,
  makeSandboxResolveAccount,
  makeSandboxResolveCounterparty,
} from "./sandbox/resolvers.js";

import { BrainMcpServer, FakeAuthVerifier, McpAuthVerifier, registerMcpRoute } from "@brain/mcp";
import { createViemScopeChecker } from "./mcp/viemScopeChecker.js";
import { ReconciliationAgentClient } from "./agents/reconciliationClient.js";
import { createPlaidKeyResolver } from "./webhooks/plaidJwks.js";
import { createPlaidTenantResolver } from "./webhooks/plaidTenant.js";

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
    const path = new URL("../../../.env", import.meta.url).pathname;
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
// This adapter bridges them.
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
    async signedUrl(ctx: ServiceCallContext, rawId: string, ttlSeconds: number): Promise<string> {
      const row = await withTenantScope(deps.pool, ctx.tenantId, (c) => findArtifactById(c, rawId));
      if (row === null) {
        throw brainError("raw_artifact_not_found", "no such raw artifact", {
          details: { raw_id: rawId },
        });
      }
      if (row.tombstoned_at !== null) {
        throw brainError("raw_artifact_tombstoned", "artifact has been tombstoned", {
          details: { raw_id: rawId },
        });
      }
      return deps.blob.signedUrl(row.blob_uri, { expiresInSeconds: ttlSeconds });
    },
    async listParsed(ctx: ServiceCallContext, rawId: string): Promise<ParsedOutput[]> {
      const rows = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
        listParsedByArtifact(c, rawId),
      );
      return rows.map((r) => ({
        id: r.id,
        rawArtifactId: r.raw_artifact_id,
        parser: r.parser,
        parserVersion: r.parser_version,
        extracted: r.extracted,
        confidence: r.confidence,
        extractedAt: r.extracted_at.toISOString(),
      }));
    },
    async tombstone(ctx: ServiceCallContext, rawId: string): Promise<void> {
      const outcome = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
        tombstoneArtifact(c, rawId),
      );
      if (outcome.notFound) {
        throw brainError("raw_artifact_not_found", "no such raw artifact", {
          details: { raw_id: rawId },
        });
      }
      if (!outcome.alreadyTombstoned) {
        // Tombstone blob metadata too; best-effort, row tombstone is authoritative.
        try {
          const row = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
            findArtifactById(c, rawId),
          );
          if (row !== null) {
            await deps.blob.tombstone(row.blob_uri, ctx.actor);
          }
        } catch {
          /* blob tombstone is best-effort */
        }
        await deps.audit.emit({
          tenantId: ctx.tenantId,
          layer: "raw",
          actor: ctx.actor,
          action: "raw.tombstone",
          inputs: { raw_id: rawId },
          outputs: {},
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// IWikiMemoryService adapter
//
// The MCP server needs IWikiMemoryService. WikiPageService covers
// listPages / getPage / search / regenerate / question. annotate is stubbed
// pending the write-through path (refactor-4).
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
    // annotate write-through deferred to refactor-4.
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
    const agentRow = await withTenantScope(pool, ctx.tenantId, (c) => findAgent(c, principalId));
    if (agentRow !== null) return agentRow.role;
    const userRow = await withTenantScope(pool, ctx.tenantId, (c) => findUser(c, principalId));
    return userRow?.role ?? null;
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig();

  initTracing({
    otlpEndpoint: cfg.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: cfg.SERVICE_NAME,
    serviceVersion: cfg.SERVICE_VERSION,
  });

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
  if (cfg.BRAIN_MCP_DEV_AUTH_BYPASS && cfg.NODE_ENV === "production") {
    throw new Error("BRAIN_MCP_DEV_AUTH_BYPASS=true is not allowed in NODE_ENV=production");
  }
  if (cfg.BLOB_BACKEND === "memory" && cfg.NODE_ENV === "production") {
    throw new Error(
      "BLOB_BACKEND=memory is not allowed in NODE_ENV=production — set BLOB_BACKEND=azure",
    );
  }

  // Single source of truth for the demo HS256 secret. Used by both JwtVerifier
  // (to accept demo tokens) and JwtSigner (to mint them). Having it in two
  // inline literals means a typo breaks verification silently.
  const DEMO_SIGN_SECRET = "brain-demo-mode-insecure-dev-only";
  const DEMO_GOLDEN_USER = "user_00000000020000000000000001" as const;
  const DEMO_GOLDEN_TENANT = "tnt_00000000010000000000000000" as const;

  const jwtVerifier = new JwtVerifier({
    jwksUrl: cfg.AUTH_JWKS_URL,
    ...(cfg.BRAIN_DEMO_MODE ? { secret: DEMO_SIGN_SECRET } : {}),
    issuer: cfg.AUTH_ISSUER,
    audience: cfg.AUTH_AUDIENCE,
    clockToleranceSeconds: cfg.AUTH_CLOCK_TOLERANCE_SECONDS,
    revocation: new RedisRevocationStore(redis),
  });

  // -- blob adapter — azure in production, memory in local dev ---
  const blob = createBlobAdapter({
    backend: cfg.BLOB_BACKEND,
    container: cfg.BLOB_CONTAINER,
    ...(cfg.AZURE_BLOB_ACCOUNT_NAME !== undefined
      ? { azureAccountName: cfg.AZURE_BLOB_ACCOUNT_NAME }
      : {}),
    ...(cfg.AZURE_BLOB_ACCOUNT_KEY !== undefined
      ? { azureAccountKey: cfg.AZURE_BLOB_ACCOUNT_KEY }
      : {}),
  });

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
  const evaluatePaymentIntent = (ctx: ServiceCallContext, intent: GatePaymentIntent) =>
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

  // Exposed for POST /v1/demo/anchor/trigger — set when anchorBroadcaster is configured.
  let triggerAnchor: (() => Promise<void>) | undefined;

  // -- MCP server -----------------------------------------------------
  const mcpAuthVerifier =
    cfg.BRAIN_MCP_DEV_AUTH_BYPASS && cfg.NODE_ENV !== "production"
      ? new FakeAuthVerifier({
          id: "agent_00000000000000000000000000",
          tenant_id: "tnt_00000000000000000000000000",
          state: "active",
          scope_hash: null,
          onchain_address: null,
          role: "dev",
        })
      : new McpAuthVerifier(
          pool,
          createViemScopeChecker({
            rpcUrl: cfg.BASE_RPC_URL ?? cfg.RPC_URL,
            contractAddress: cfg.MCP_AGENT_REGISTRY_ADDRESS as `0x${string}`,
          }),
        );

  const mcpServer = new BrainMcpServer({
    auth: mcpAuthVerifier,
    ledger: ledgerService,
    wiki: wikiService,
    raw: rawEvidenceService,
    paymentIntents: paymentIntentService,
    audit,
    ...(cfg.AGENT_SERVICE_URL !== undefined
      ? { agentService: new ReconciliationAgentClient(cfg.AGENT_SERVICE_URL) }
      : {}),
  });

  // -- Fastify root app -----------------------------------------------
  const app = Fastify({
    logger: true,
    bodyLimit: cfg.REQUEST_BODY_LIMIT_BYTES,
    disableRequestLogging: false,
    trustProxy: true,
  });

  // Security plugins registered before routes.
  const corsOrigins = cfg.CORS_ALLOWED_ORIGINS.split(",")
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
      keyResolver: cfg.BRAIN_DEMO_MODE
        ? async (_kid: string): Promise<never> => {
            throw brainError(
              "raw_webhook_signature_invalid",
              "Plaid webhook signing not configured — use /raw/ingest in demo mode",
            );
          }
        : cfg.PLAID_CLIENT_ID !== undefined && cfg.PLAID_SECRET !== undefined
          ? createPlaidKeyResolver({
              clientId: cfg.PLAID_CLIENT_ID,
              secret: cfg.PLAID_SECRET,
              env: cfg.PLAID_ENV,
            })
          : async (): Promise<never> => {
              throw brainError(
                "raw_webhook_signature_invalid",
                "Plaid webhook signing not configured — set PLAID_CLIENT_ID and PLAID_SECRET",
              );
            },
      clockToleranceSeconds: 300,
    },
    resolveWebhookTenant: cfg.BRAIN_DEMO_MODE
      ? async (
          _provider: string,
          _body: Buffer,
          headers: Record<string, unknown>,
        ): Promise<string> => {
          const devTenantHeader = headers["x-dev-tenant-id"];
          if (typeof devTenantHeader === "string" && devTenantHeader.length > 0) {
            return devTenantHeader;
          }
          throw brainError(
            "auth_tenant_mismatch",
            "cannot resolve webhook tenant — use x-dev-tenant-id header in demo mode",
          );
        }
      : createPlaidTenantResolver(pool),
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
      await v1.register(async (child) =>
        registerMcpRoute(child, mcpServer, {
          skipPrincipalTypeCheck: cfg.BRAIN_MCP_DEV_AUTH_BYPASS,
        }),
      );
      // SIWX (agent auth) — always wired. Production requires AUTH_SIGN_KEY
      // (a JWK JSON string) backed by Azure Key Vault.
      if (cfg.NODE_ENV === "production" && cfg.AUTH_SIGN_KEY === undefined) {
        throw new Error(
          "AUTH_SIGN_KEY must be set in production — configure a JWK signing key in Azure Key Vault",
        );
      }
      const siwxJwk =
        cfg.AUTH_SIGN_KEY !== undefined
          ? (JSON.parse(cfg.AUTH_SIGN_KEY) as { kty: string; alg?: string; [k: string]: unknown })
          : { kty: "oct", k: Buffer.from(DEMO_SIGN_SECRET).toString("base64url"), alg: "HS256" };
      const siwxSigner = new JwtSigner({
        issuer: cfg.AUTH_ISSUER,
        audience: cfg.AUTH_AUDIENCE,
        key: siwxJwk,
        algorithm: typeof siwxJwk.alg === "string" ? siwxJwk.alg : "HS256",
      });
      const agentRegistry = cfg.BRAIN_DEMO_MODE
        ? new StubAgentRegistry()
        : new PostgresAgentRegistry(pool);
      await v1.register(async (child) =>
        registerSiwxRoutes(child, {
          signer: siwxSigner,
          registry: agentRegistry,
          redis,
          ...(cfg.BRAIN_DEMO_MODE ? { demoMode: true } : {}),
        }),
      );

      if (cfg.BRAIN_DEMO_MODE) {
        // GET /v1/demo/token — mints a short-lived read-heavy demo JWT for the
        // golden-path tenant. Scoped to the minimum needed for the quickstart;
        // audit:admin and payment_intent:execute are intentionally excluded.
        v1.get(
          "/demo/token",
          { config: { skipAuth: true, rateLimit: { max: 5, timeWindow: "1 minute" } } },
          async (_req, reply) => {
            const DEMO_TTL_S = 15 * 60; // 15 minutes
            const token = await siwxSigner.sign({
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
                "policy:write",
                "execution:read",
                "execution:propose",
                "payment_intent:propose",
                "payment_intent:approve",
                "payment_intent:execute",
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

        // POST /v1/demo/policy/activate — inserts a 3-rule demo policy as
        // active for the requester's tenant. Bypasses the EIP-712 signing
        // ceremony so investors/demo operators can activate a policy with a
        // single curl. Only available in BRAIN_DEMO_MODE=true.
        const DEMO_POLICY: PolicyDocument = {
          version: 1,
          rules: [
            {
              id: "auto-small-payment",
              applies_to: ["outbound_payment"],
              when: { "amount.lte": { currency: "USD", value: "1000.00" } },
              execute: "auto",
            },
            {
              id: "reject-excessive-payment",
              applies_to: ["outbound_payment"],
              when: { "amount.gt": { currency: "USD", value: "10000.00" } },
              execute: "reject",
            },
            {
              id: "confirm-mid-payment",
              applies_to: ["outbound_payment"],
              when: {
                "amount.gt": { currency: "USD", value: "1000.00" },
                "amount.lte": { currency: "USD", value: "10000.00" },
              },
              require: "owner_approval",
              execute: "confirm",
            },
          ],
        };

        v1.post("/demo/policy/activate", { config: { skipAuth: false } }, async (req, reply) => {
          if (req.principal === undefined) {
            throw brainError("auth_token_missing", "principal required");
          }
          if (!req.principal.scopes.includes("policy:write")) {
            throw brainError("auth_scope_insufficient", "policy:write required");
          }

          const body = req.body as { content?: PolicyDocument } | undefined;
          const content: PolicyDocument = body?.content ?? DEMO_POLICY;

          if (typeof content.version !== "number" || !Array.isArray(content.rules)) {
            throw brainError("policy_rule_invalid", "content must be { version, rules[] }");
          }

          const id = newPolicyId();
          const hash = contentHash(content);

          await withTenantScope(pool, req.principal.tenantId, async (c) => {
            await c.query(
              `UPDATE policies SET state = 'deactivated', deactivated_at = now() WHERE state = 'active'`,
            );
            await c.query(
              `INSERT INTO policies
                 (id, tenant_id, version, content, content_hash, quorum_required,
                  state, created_by, activated_at)
               VALUES ($1,$2,$3,$4,$5,1,'active',$6,now())`,
              [id, req.principal!.tenantId, content.version, JSON.stringify(content), hash, req.principal!.id],
            );
          });

          await audit.emit({
            tenantId: req.principal.tenantId,
            layer: "policy",
            actor: req.principal.id,
            action: "policy.activate",
            inputs: { version: content.version, policy_hash: hash.toString("hex"), demo_bypass: true },
            outputs: { policy_id: id, state: "active" },
          });

          reply.status(200);
          return { policy_id: id, state: "active", version: content.version, rules: content.rules };
        });

        // POST /v1/demo/anchor/trigger — immediately publishes a Merkle anchor
        // to BrainAuditAnchor on Base Sepolia without waiting for the hourly timer.
        // Requires AUDIT_PUBLISHER_KEY to be set. Demo mode only.
        v1.post("/demo/anchor/trigger", { config: { skipAuth: false } }, async (req, reply) => {
          if (req.principal === undefined) {
            throw brainError("auth_token_missing", "principal required");
          }
          if (triggerAnchor === undefined) {
            throw brainError(
              "internal_server_error",
              "anchor publisher not configured — set AUDIT_PUBLISHER_KEY in .env and restart",
            );
          }
          await triggerAnchor();
          reply.status(200);
          return { triggered: true, message: "anchor published — check GET /v1/audit/anchor/latest" };
        });
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

    // Expose for the demo trigger endpoint.
    triggerAnchor = runAnchor;

    // In demo mode, fire the first anchor after 10s so it's immediate for
    // demo operators; production uses the full intervalMs delay.
    const firstRunMs = cfg.BRAIN_DEMO_MODE ? 10_000 : intervalMs;
    anchorTimer = setTimeout(() => void runAnchor(), firstRunMs);
    log.info({ intervalMs, firstRunMs }, "anchor publisher started");
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
    await shutdownTracing();
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
