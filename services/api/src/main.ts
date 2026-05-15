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
import { Redis } from "ioredis";
import {
  authPlugin,
  errorHandlerPlugin,
  requestIdPlugin,
  idempotencyPlugin,
  JwtVerifier,
  PostgresAuditEmitter,
  RedisIdempotencyStore,
  InMemoryRevocationStore,
  createLogger,
  createPool,
  MemoryBlobAdapter,
  MockMetrics,
  DeterministicEmbeddingAdapter,
  loadConfig,
  brainError,
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
} from "@brain/api/shared";

import {
  registerRawPlugin,
  ingestOne,
  type RegisterRawPluginOptions,
} from "@brain/raw";

import { LedgerService, registerLedgerPlugin } from "@brain/ledger";

import {
  WikiPageService,
  registerWikiPlugin,
  loadRegistry,
} from "@brain/wiki";

import { registerPolicyRoutes } from "@brain/policy";
import type { PolicyDeps } from "@brain/policy";

import {
  registerExecutionRoutes,
  registerPaymentIntentRoutes,
  ApprovalService,
  PaymentIntentService,
  defaultRails,
} from "@brain/execution";
import type { ExecutionDeps } from "@brain/execution";

import { registerAuditRoutes } from "@brain/audit";
import type { AuditDeps } from "@brain/audit";

import {
  BrainMcpServer,
  FakeAuthVerifier,
  registerMcpRoute,
} from "@brain/mcp";

import type { LedgerDeps } from "@brain/ledger";
import type { WikiDeps } from "@brain/wiki";
import type { RawDeps } from "@brain/raw";
import type {
  GateAccount,
  GateAgent,
  GateCounterparty,
  GatePaymentIntent,
  GatePolicyDecision,
  GatePrincipal,
} from "@brain/api/shared";

// ---------------------------------------------------------------------------
// .env loader (optional — repo-root .env only)
// ---------------------------------------------------------------------------

try {
  // Node 20.12+ built-in. Silently skip if file not found or function absent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    async listParsed(
      _ctx: ServiceCallContext,
      _rawId: string,
    ): Promise<ParsedOutput[]> {
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

function buildWikiMemoryService(pageService: WikiPageService): IWikiMemoryService {
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
    // TODO: wire to askWiki orchestrator with real LLM deps.
    async question(
      _ctx: ServiceCallContext,
      _req: QuestionRequest,
    ): Promise<QuestionAnswer> {
      throw brainError(
        "internal_server_error",
        "wiki.question not yet wired in boot binary — supply OPENAI_API_KEY and wire askWiki",
      );
    },
    // TODO: wire to the annotate write-through path.
    async annotate(
      _ctx: ServiceCallContext,
      _input: AnnotationInput,
    ): Promise<{ annotation_id: string; raw_artifact_id: string }> {
      throw brainError(
        "internal_server_error",
        "wiki.annotate not yet wired in boot binary",
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Stub hook factories — reduce repetition in ExecutionDeps / PaymentIntentDeps
// ---------------------------------------------------------------------------

function stubResolveAgent(
  _ctx: ServiceCallContext,
  _agentId: string,
): Promise<GateAgent | null> {
  // TODO: wire to the execution agents table.
  return Promise.resolve(null);
}

function stubResolveAccount(
  _ctx: ServiceCallContext,
  _accountId: string,
): Promise<GateAccount | null> {
  // TODO: wire to LedgerService.getAccount.
  return Promise.resolve(null);
}

function stubResolveCounterparty(
  _ctx: ServiceCallContext,
  _counterpartyId: string,
): Promise<GateCounterparty | null> {
  // TODO: wire to LedgerService listCounterparties.
  return Promise.resolve(null);
}

function stubResolvePrincipal(ctx: ServiceCallContext): Promise<GatePrincipal> {
  // TODO: wire to JWT claims on the request principal.
  return Promise.resolve({ id: ctx.actor, type: "user" as const, scopes: [] });
}

function stubResolveRole(
  _ctx: ServiceCallContext,
  _principalId: string,
): Promise<string | null> {
  // TODO: wire to the agents / users role table.
  return Promise.resolve(null);
}

function stubEvaluatePaymentIntent(
  _ctx: ServiceCallContext,
  _intent: GatePaymentIntent,
): Promise<GatePolicyDecision> {
  // TODO: wire to Policy service evaluate() function.
  return Promise.reject(
    brainError("internal_server_error", "evaluatePaymentIntent hook not yet wired in boot binary"),
  );
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

  const audit = new PostgresAuditEmitter(pool);

  const jwtVerifier = new JwtVerifier({
    jwksUrl: cfg.AUTH_JWKS_URL,
    issuer: cfg.AUTH_ISSUER,
    audience: cfg.AUTH_AUDIENCE,
    clockToleranceSeconds: cfg.AUTH_CLOCK_TOLERANCE_SECONDS,
    // TODO: swap to RedisRevocationStore in production.
    revocation: new InMemoryRevocationStore(),
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

  // Wiki LLM + embed adapters. Use DeterministicEmbeddingAdapter as stub
  // until OPENAI_API_KEY is supplied.
  // TODO: replace with real OpenAICompletionAdapter + OpenAIEmbeddingAdapter
  //       when OPENAI_API_KEY is set.
  const deterministicEmbed = new DeterministicEmbeddingAdapter();

  const wikiDeps: WikiDeps = {
    pool,
    redis,
    audit,
    // TODO: wire AnthropicAdapter when ANTHROPIC_API_KEY is set.
    llm: {
      complete: async () => {
        throw brainError(
          "internal_server_error",
          "LLM not configured — supply ANTHROPIC_API_KEY",
        );
      },
    },
    embed: deterministicEmbed,
    schemas: schemaRegistry,
    metrics,
    questionModel: cfg.WIKI_LLM_MODEL,
  };

  const wikiPageService = new WikiPageService({ pool, audit });
  const wikiService = buildWikiMemoryService(wikiPageService);

  const policyDeps: PolicyDeps = {
    pool,
    audit,
    // Base Sepolia chain id.
    chainId: 84532,
    policyRegistryAddress: cfg.MCP_AGENT_REGISTRY_ADDRESS as `0x${string}`,
  };

  const rawEvidenceService = buildRawEvidenceService(rawDeps);

  const approvalService = new ApprovalService({
    pool,
    audit,
    resolveRole: stubResolveRole,
  });

  const paymentIntentService = new PaymentIntentService({
    pool,
    audit,
    rails: defaultRails(),
    approvals: approvalService,
    resolveAgent: stubResolveAgent,
    resolveAccount: stubResolveAccount,
    resolveCounterparty: stubResolveCounterparty,
    evaluatePolicy: stubEvaluatePaymentIntent,
    resolvePrincipal: stubResolvePrincipal,
  });

  const executionDeps: ExecutionDeps = {
    pool,
    audit,
    rails: defaultRails(),
    // TODO: wire evaluatePolicy (legacy) to the Policy service.
    evaluatePolicy: async (
      _tenantId: string,
      _action: Record<string, unknown>,
    ): Promise<{
      outcome: "allow" | "confirm" | "reject";
      matched_rule_id: string | null;
      required_approvers: string[];
      trace: unknown[];
      policy_version: number;
    }> => {
      throw brainError(
        "internal_server_error",
        "evaluatePolicy (legacy) not yet wired in boot binary",
      );
    },
    evaluatePaymentIntent: stubEvaluatePaymentIntent,
    resolveAgent: stubResolveAgent,
    resolveAccount: stubResolveAccount,
    resolveCounterparty: stubResolveCounterparty,
    resolvePrincipal: stubResolvePrincipal,
    resolveRole: stubResolveRole,
  };

  const auditDeps: AuditDeps = { pool, audit };

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
    logger: log as Parameters<typeof Fastify>[0]["logger"],
    bodyLimit: cfg.REQUEST_BODY_LIMIT_BYTES,
    disableRequestLogging: false,
  });

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

  // Service layer route registrations.
  // Raw: also registers content-type parsers + multipart inside registerRawPlugin.
  const rawOpts: RegisterRawPluginOptions = {
    plaidVerify: {
      // TODO: populate from config when Plaid credentials are set.
      // The verifier requires a keyResolver — stubbed to always reject
      // until PLAID_CLIENT_ID / PLAID_SECRET are wired.
      keyResolver: async (): Promise<never> => {
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
      throw brainError(
        "auth_tenant_mismatch",
        "cannot resolve webhook tenant — not configured",
      );
    },
  };

  await app.register(async (child) => registerRawPlugin(child, rawDeps, rawOpts));
  await app.register(async (child) => registerLedgerPlugin(child, ledgerDeps));
  await app.register(async (child) => registerWikiPlugin(child, wikiDeps));
  await app.register(async (child) => registerPolicyRoutes(child, policyDeps));
  await app.register(async (child) => registerExecutionRoutes(child, executionDeps));
  await app.register(async (child) => {
    // PaymentIntentService has its own approval sub-service; create a fresh
    // instance scoped to this plugin so it doesn't share mutable state.
    const piApprovals = new ApprovalService({
      pool,
      audit,
      resolveRole: stubResolveRole,
    });
    const piService = new PaymentIntentService({
      pool,
      audit,
      rails: defaultRails(),
      approvals: piApprovals,
      resolveAgent: stubResolveAgent,
      resolveAccount: stubResolveAccount,
      resolveCounterparty: stubResolveCounterparty,
      evaluatePolicy: stubEvaluatePaymentIntent,
      resolvePrincipal: stubResolvePrincipal,
    });
    await registerPaymentIntentRoutes(child, piService);
  });
  await app.register(async (child) => registerAuditRoutes(child, auditDeps));
  await app.register(async (child) => registerMcpRoute(child, mcpServer));

  // -- listen ---------------------------------------------------------
  await app.listen({ host: "0.0.0.0", port: cfg.PORT });
  log.info({ port: cfg.PORT, version: cfg.SERVICE_VERSION }, "brain-server up");

  // -- graceful shutdown ----------------------------------------------
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutting down");
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
