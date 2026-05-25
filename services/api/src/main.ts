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
  brainId,
  withTenantScope,
  createRoutingEnqueue,
  isDomainEvent,
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
import { createViemAnchorBroadcaster, createViemAnchorEventReader } from "./anchorBroadcaster.js";
import { registerProofRoutes, poolProofBuilder } from "./proof/routes.js";
import { makeRunLoaders } from "./agents/run-loaders.js";

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

import {
  registerPolicyRoutes,
  PolicyService,
  contentHash,
  getActive as policyGetActive,
  getById as policyGetById,
} from "@brain/policy";
import type { PolicyDeps, PolicyDocument, PolicyRow } from "@brain/policy";

import {
  registerExecutionRoutes,
  registerPaymentIntentRoutes,
  ApprovalService,
  PaymentIntentService,
  OutboxService,
  AgentService,
  defaultRails,
  findAgent,
  findUser,
  insertAgentRun,
  insertRoutingDecision,
  findAgentRun,
  listAgentRuns,
  findRoutingDecision,
  transitionAgent,
  releaseAgentQuarantine,
} from "@brain/execution";
import type { ExecutionDeps } from "@brain/execution";

import {
  registerAuditRoutes,
  registerWebhookRoutes,
  publishAnchor,
  startAnchorReconciler,
} from "@brain/audit";
import type { AuditDeps } from "@brain/audit";

import {
  sandboxEvaluateLegacyPolicy,
  sandboxResolveAgent,
  sandboxResolvePrincipal,
  sandboxResolveRole,
  sandboxResolveTenantFlags,
  makeSandboxResolveAccount,
  makeSandboxResolveCounterparty,
} from "./sandbox/resolvers.js";

import { BrainMcpServer, FakeAuthVerifier, McpAuthVerifier, registerMcpRoute } from "@brain/mcp";
import {
  ActionResolver,
  AgentRouter,
  AgentRunService,
  EmbeddingIntentClassifier,
  FallbackIntentClassifier,
  RulesIntentClassifier,
  StaticEvidenceGatherer,
  createAgentRouteWorker,
  reindexIntentClassifier,
  registerAgentApiRoutes,
  StaticPromotionPolicy,
  LIVE_AGENTS,
  type AgentRunStore,
  type AgentApiReadStore,
  type IntentClassifier,
} from "@brain/agent-router";
import {
  internalAgentCatalog,
  internalAgentDefinitions,
  internalAgentHandlers,
} from "@brain/internal-agents";
import { createViemScopeChecker } from "./mcp/viemScopeChecker.js";
import { createViemPolicySignerChecker } from "./policy/viemPolicySignerChecker.js";
import { ReconciliationAgentClient } from "./agents/reconciliationClient.js";
import { createPlaidKeyResolver } from "./webhooks/plaidJwks.js";
import { createPlaidTenantResolver } from "./webhooks/plaidTenant.js";

import type { LedgerDeps } from "@brain/ledger";
import type { WikiDeps, PolicyReader, AgentReader, PolicyView } from "@brain/wiki";
import type { RawDeps } from "@brain/raw";
import type {
  GateAccount,
  GateAgent,
  GateCounterparty,
  GatePaymentIntent,
  GatePrincipal,
  GateTenantFlags,
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

function makeResolveTenantFlags(
  pool: ReturnType<typeof createPool>,
): (ctx: ServiceCallContext, tenantId: string) => Promise<GateTenantFlags> {
  return async (ctx, tenantId) => {
    // No row ⇒ flags default off (back-compat). RLS scopes the read to the
    // caller's own tenant; we also filter by id so an admin BYPASSRLS connection
    // would still read the correct tenant.
    const row = await withTenantScope(pool, ctx.tenantId, async (c) => {
      const res = await c.query<{ require_behavior_hash: boolean }>(
        `SELECT require_behavior_hash FROM tenants WHERE id = $1`,
        [tenantId],
      );
      return res.rows[0] ?? null;
    });
    return { requireBehaviorHash: row?.require_behavior_hash ?? false };
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

  // H-14: the Wiki layer uses a separate pool connecting as the read-only
  // `brain_wiki_reader` role (SELECT anywhere; write only wiki_* tables) so an
  // accidental ledger_* write from a Wiki path raises a Postgres permission
  // error. Falls back to the main pool in dev/test with a warning.
  let wikiPool = pool;
  if (cfg.BRAIN_WIKI_DB_URL !== undefined) {
    wikiPool = createPool({
      connectionString: cfg.BRAIN_WIKI_DB_URL,
      max: cfg.DATABASE_POOL_MAX,
      statementTimeoutMs: cfg.DATABASE_STATEMENT_TIMEOUT_MS,
      applicationName: `${cfg.SERVICE_NAME}-wiki`,
    });
  } else {
    console.warn(
      "[boot] BRAIN_WIKI_DB_URL unset — Wiki shares the main DATABASE_URL (full privileges). " +
        "Set it to the brain_wiki_reader role in production (H-14).",
    );
  }

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

  // Cross-service read ports for the Wiki policy/agent page generators. Wiki
  // must not query the Policy/Execution tables directly, so the composition
  // root (which already imports both services) supplies adapters backed by the
  // owning service's read API over the shared pool.
  const toPolicyView = (row: PolicyRow): PolicyView => ({
    id: row.id,
    version: row.version,
    state: row.state,
    quorum_required: row.quorum_required,
    signers: (row.signers ?? []).map((s) => ({ address: s.address })),
    activated_at: row.activated_at,
    deactivated_at: row.deactivated_at,
    created_by: row.created_by,
    created_at: row.created_at,
  });
  const policyReader: PolicyReader = {
    byId: (rctx, id) =>
      withTenantScope(pool, rctx.tenantId, async (c) => {
        const row = await policyGetById(c, id);
        return row === null ? null : toPolicyView(row);
      }),
    active: (rctx) =>
      withTenantScope(pool, rctx.tenantId, async (c) => {
        const row = await policyGetActive(c);
        return row === null ? null : toPolicyView(row);
      }),
  };
  const agentReader: AgentReader = {
    byId: (rctx, id) =>
      withTenantScope(pool, rctx.tenantId, async (c) => {
        const row = await findAgent(c, id);
        return row === null
          ? null
          : {
              id: row.id,
              kind: row.kind,
              role: row.role,
              display_name: row.display_name,
              onchain_address: row.onchain_address,
              state: row.state,
              registered_at: row.registered_at,
              created_at: row.created_at,
            };
      }),
  };

  const wikiDeps: WikiDeps = {
    // H-14: read-only (brain_wiki_reader) pool when BRAIN_WIKI_DB_URL is set.
    pool: wikiPool,
    redis,
    audit,
    llm,
    embed,
    schemas: schemaRegistry,
    metrics,
    questionModel: cfg.WIKI_LLM_MODEL,
    policyReader,
    agentReader,
  };

  const wikiPageService = new WikiPageService({ pool, audit, embed, policyReader, agentReader });
  const wikiService = buildWikiMemoryService(wikiPageService, wikiDeps);

  const policyDeps: PolicyDeps = {
    pool,
    audit,
    // Base Sepolia chain id.
    chainId: 84532,
    policyRegistryAddress: cfg.POLICY_REGISTRY_ADDRESS as `0x${string}`,
    // Quorum signers must be on the on-chain BrainPolicyRegistry allowlist. In
    // demo mode the chain is sandboxed, so any signer is accepted (mirrors the
    // other sandbox resolvers below).
    isAuthorizedSigner: cfg.BRAIN_DEMO_MODE
      ? () => Promise.resolve(true)
      : createViemPolicySignerChecker({
          contractAddress: cfg.POLICY_REGISTRY_ADDRESS as `0x${string}`,
          rpcUrl: cfg.BASE_RPC_URL ?? cfg.RPC_URL,
        }),
  };

  const policyService = new PolicyService({ pool, audit });

  const rawEvidenceService = buildRawEvidenceService(rawDeps);

  // Resolver hooks — sandbox replacements when BRAIN_DEMO_MODE is on.
  const resolveRole = cfg.BRAIN_DEMO_MODE ? sandboxResolveRole : makeResolveRole(pool);
  const resolveAgent = cfg.BRAIN_DEMO_MODE ? sandboxResolveAgent : makeResolveAgent(pool);
  const resolveTenantFlags = cfg.BRAIN_DEMO_MODE
    ? sandboxResolveTenantFlags
    : makeResolveTenantFlags(pool);
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
    // H-04: execute enqueues to the durable outbox; the rail moved to the worker.
    outbox: new OutboxService(),
    approvals: approvalService,
    resolveAgent,
    resolveTenantFlags,
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
    resolveTenantFlags,
    resolveAccount,
    resolveCounterparty,
    resolvePrincipal,
    resolveRole,
  };

  // H-04 durable execution outbox. `execute` now enqueues a `pending`
  // execution_outbox row (atomic with approved → dispatching); the rail is
  // dispatched + the intent settled asynchronously by the outbox worker
  // (startOutboxWorker from @brain/execution). The worker is a poll loop over
  // execution_outbox (FOR UPDATE SKIP LOCKED) — NOT a BullMQ/Redis queue — and
  // claims rows cross-tenant, so it needs a `brain_privileged` (BYPASSRLS)
  // connection for claim/mark and re-enters withTenantScope per row to settle.
  // It is intentionally NOT started inline here: like the anchor publisher /
  // outbound-webhook retry workers it is a deployable background process, and it
  // is unverifiable in the sandbox (no Postgres). Wiring (privileged pool +
  // RailRegistry + PaymentIntentService as the OutboxExecutor) is a follow-up to
  // land alongside the H-04 pg integration tests. Until the worker runs, intents
  // remain in `dispatching` — they are durably recorded and never lost.

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

  // Anchor orphan-recovery reconciler: heals anchors whose on-chain tx-hash
  // write was lost after a successful broadcast. Read-only — runs whenever the
  // anchor contract address and an RPC URL are configured (no publisher key).
  const anchorRpcUrl = cfg.BASE_RPC_URL ?? cfg.RPC_URL;
  const anchorReconciler =
    cfg.AUDIT_ANCHOR_ADDRESS !== undefined && anchorRpcUrl !== undefined
      ? startAnchorReconciler({
          pool,
          audit,
          reader: createViemAnchorEventReader({
            contractAddress: cfg.AUDIT_ANCHOR_ADDRESS as `0x${string}`,
            rpcUrl: anchorRpcUrl,
          }),
        })
      : undefined;

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

  const agentService = new AgentService({
    pool,
    audit,
    evaluatePolicy: evaluateLegacyPolicy,
  });

  const mcpServer = new BrainMcpServer({
    auth: mcpAuthVerifier,
    ledger: ledgerService,
    wiki: wikiService,
    raw: rawEvidenceService,
    paymentIntents: paymentIntentService,
    agentService,
    audit,
  });

  // -- Agent router (Phase 1) -----------------------------------------
  // Shared StaticEvidenceGatherer for now.
  // TODO(phase-1): wire Wiki citations + Ledger references into a
  // ServiceEvidenceGatherer. Until then evidence is empty, so agents with
  // required_evidence resolve to notify_only (the safe default).
  const agentEvidence = new StaticEvidenceGatherer();
  // TODO(phase-1): enforce real per-tenant on-chain scope grants via the agent
  // registry. For now the Brain-shipped internal agents' capabilities are
  // treated as scoped (they are enabled_by_default).
  const internalAgentCapabilities = new Set(internalAgentCatalog.flatMap((d) => d.capabilities));
  // Intent-classifier strategy (Phase 4 feature flag). "rules" (default) keeps
  // the deterministic token-overlap classifier; "embedding" makes the router
  // paraphrase-aware via embeddings, with the rules classifier as a live
  // fallback when the embedding adapter returns no match or is unavailable.
  const rulesClassifier = new RulesIntentClassifier();
  let agentClassifier: IntentClassifier = rulesClassifier;
  if (cfg.AGENT_INTENT_CLASSIFIER === "embedding") {
    const embeddingClassifier = new EmbeddingIntentClassifier(embed, {
      model: cfg.WIKI_EMBED_MODEL,
    });
    // Warm the pattern cache so the first live request avoids embed latency.
    // Fire-and-forget: a miss is filled lazily on first use.
    void reindexIntentClassifier(embeddingClassifier, internalAgentCatalog);
    agentClassifier = new FallbackIntentClassifier(embeddingClassifier, rulesClassifier);
  }
  const agentRouter = new AgentRouter({
    catalog: () => internalAgentCatalog,
    classifier: agentClassifier,
    evidence: agentEvidence,
    getScopedCapabilities: () => internalAgentCapabilities,
    // TODO(phase-3): resolve the tenant category from a signed JWT claim or a
    // tenant record. Until then every tenant is treated as "business", which
    // keeps shared triggers (e.g. cash.balance_high) routing to the business
    // agent deterministically; consumer routing activates once a real source
    // is wired.
    getTenantCategory: () => "business",
    audit,
  });

  // Picks the action within the selected agent (replaces handler.actions[0]),
  // using the same classifier the router uses for intent_action_map scoring.
  // H-23: the resolver enforces the signed policy's per-agent allowlist via the
  // `isActionAllowed` hook (PolicyDocument.agent_actions + allowedActionsFor in
  // @brain/policy). Live injection is intentionally NOT a boot-time closure over
  // a single policy — that would apply one tenant's allowlist to all tenants (a
  // tenant-isolation bug). It must load the *requesting tenant's* active signed
  // policy per call (policy service getActive → allowedActionsFor), which is a
  // DB-backed path verified in a Postgres-capable environment. Until wired, an
  // explicit action is accepted if the agent offers it (pre-H-23 behavior).
  const actionResolver = new ActionResolver({ classifier: agentClassifier });

  // Delegate the reconciliation agent to the Python reconciliation service when
  // RECONCILIATION_AGENT_URL is set; otherwise reconciliation uses the default
  // AgentService. ReconciliationAgentClient is itself an IAgentService.
  const reconciliationAgentUrl = process.env.RECONCILIATION_AGENT_URL;
  const agentOverrides =
    reconciliationAgentUrl !== undefined
      ? { reconciliation: new ReconciliationAgentClient(reconciliationAgentUrl) }
      : {};

  // -- Agent run persistence + run service (Agent Autonomy v3, 1a.3/1a.6) ---
  // Runs persist through the execution-owned agent_runs tables (tenant-scoped,
  // RLS). The store boundary keeps @brain/agent-router free of an execution dep.
  const agentRunStore: AgentRunStore = {
    recordRoutingDecision: (rdCtx, input) =>
      withTenantScope(pool, rdCtx.tenantId, async (c) => {
        const row = await insertRoutingDecision(c, {
          id: brainId("agrd"),
          tenantId: rdCtx.tenantId,
          tenantCategory: input.tenantCategory,
          policyStatus: input.policyStatus,
          reason: input.reason,
          selectedAgentId: input.selectedAgentId,
          fallbackAgentIds: [...input.fallbackAgentIds],
          confidence: input.confidence,
          evidenceScore: input.evidenceScore,
          eventType: input.eventType ?? null,
          intent: input.intent ?? null,
        });
        return { id: row.id };
      }),
    recordRun: (runCtx, input) =>
      withTenantScope(pool, runCtx.tenantId, async (c) => {
        const row = await insertAgentRun(c, {
          id: brainId("agnr"),
          tenantId: runCtx.tenantId,
          tenantCategory: input.tenantCategory,
          agentId: input.agentId,
          agentKind: input.agentKind,
          executionMode: input.executionMode,
          status: input.status,
          reason: input.reason,
          shadowMode: input.shadowMode,
          routingDecisionId: input.routingDecisionId,
          eventType: input.eventType ?? null,
          intent: input.intent ?? null,
          action: input.action ?? null,
          confidence: input.confidence ?? null,
          evidenceScore: input.evidenceScore ?? null,
          policyStatus: input.policyStatus ?? null,
          proposalId: input.proposalId ?? null,
          paymentIntentId: input.paymentIntentId ?? null,
          failureReason: input.failureReason ?? null,
        });
        return { id: row.id };
      }),
  };

  const agentApiReads: AgentApiReadStore = {
    listRuns: (readCtx, filter) =>
      withTenantScope(pool, readCtx.tenantId, (c) =>
        // status is a free string at the HTTP boundary; the CHECK constraint and
        // the AgentRunStatus type are the source of truth for valid values.
        listAgentRuns(c, filter as Parameters<typeof listAgentRuns>[1]),
      ),
    findRun: (readCtx, id) => withTenantScope(pool, readCtx.tenantId, (c) => findAgentRun(c, id)),
    findRoutingDecision: (readCtx, id) =>
      withTenantScope(pool, readCtx.tenantId, (c) => findRoutingDecision(c, id)),
  };

  const routingEnqueue = createRoutingEnqueue({ redisUrl: cfg.REDIS_URL });

  // Graduated money-movement promotion (Phase 1b). The live-agent allowlist
  // lives in services/agent-router/src/promotion-config.ts (LIVE_AGENTS) — the
  // single file a change to which CI gates via scripts/check-promotion-readiness
  // (H-24). Default = empty => every financial proposal terminates as
  // shadow_completed until an agent is promoted with its allowed rails.
  const promotionPolicy = new StaticPromotionPolicy(LIVE_AGENTS);
  const railKindForAction = (actionType: string): string => {
    if (actionType.startsWith("ach")) return "ach";
    if (actionType === "wire") return "wire";
    if (actionType === "onchain_transfer") return "onchain";
    if (actionType === "erp_writeback") return "erp";
    if (actionType === "card_payment") return "card";
    return actionType;
  };
  const agentRunService = new AgentRunService({
    router: agentRouter,
    actionResolver,
    handlers: internalAgentHandlers,
    definitions: internalAgentDefinitions,
    evidence: agentEvidence,
    propose: { agents: agentService, paymentIntents: paymentIntentService },
    store: agentRunStore,
    getTenantCategory: () => "business",
    isShadowed: (agentId) => !promotionPolicy.isLive(agentId),
    checkRail: (agentId, actionType) =>
      promotionPolicy.isRailAllowed(agentId, railKindForAction(actionType)),
    intentClassifierStrategy: cfg.AGENT_INTENT_CLASSIFIER === "embedding" ? "embedding" : "rules",
    agentOverrides,
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
  const idempotencyStore = new RedisIdempotencyStore(redis);
  await app.register(idempotencyPlugin, {
    store: idempotencyStore,
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
    idempotencyStore,
    idempotencyTtlSeconds: cfg.IDEMPOTENCY_TTL_SECONDS,
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
          // H-04: execute enqueues to the durable outbox; rail moved to the worker.
          outbox: new OutboxService(),
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
      // H-20 webhook dead-letter + replay: /v1/webhooks/{endpoint_id}/{dead-letters,replay}.
      await v1.register(async (child) => registerWebhookRoutes(child, { pool }));
      // H-07 Proof API — GET /v1/proof/{action_id}. Flagship trust artifact:
      // one verifiable proof per action, assembled across Ledger/Policy/Audit/Raw.
      // Shared with the H-25 run-history /proof sub-resource below.
      const proofBuilder = poolProofBuilder(pool, {
        anchorContractAddress: cfg.AUDIT_ANCHOR_ADDRESS ?? null,
        chain: "base-sepolia",
      });
      await v1.register(async (child) => registerProofRoutes(child, { buildProof: proofBuilder }));
      await v1.register(async (child) =>
        registerMcpRoute(child, mcpServer, {
          skipPrincipalTypeCheck: cfg.BRAIN_MCP_DEV_AUTH_BYPASS,
        }),
      );
      // /v1/agents/* — unified agent API surface (Agent Autonomy v3, 1a.6):
      // list/get, route, run (shadow-aware), events, runs, why, routing-decisions.
      await v1.register(async (child) =>
        registerAgentApiRoutes(child, {
          catalog: () => internalAgentCatalog,
          router: agentRouter,
          runService: agentRunService,
          reads: agentApiReads,
          // H-25: run-history sub-resources (evidence / gate-trace / proof / why).
          runHistory: makeRunLoaders(pool, proofBuilder),
          // H-09: release an agent's contribution quarantine.
          releaseAgentQuarantine: (ctx, agentId) =>
            withTenantScope(pool, ctx.tenantId, (c) => releaseAgentQuarantine(c, agentId)),
          enqueueRouteJob: async (jobCtx, payload) => {
            if (payload.event === undefined || !isDomainEvent(payload.event)) {
              throw brainError(
                "request_body_invalid",
                "`event` must be a known domain event for the events queue",
              );
            }
            await routingEnqueue({
              tenantId: jobCtx.tenantId,
              ...(jobCtx.requestId !== undefined ? { requestId: jobCtx.requestId } : {}),
              payload: {
                event: payload.event,
                ...(payload.context !== undefined ? { context: payload.context } : {}),
              },
            });
            return { jobId: jobCtx.requestId ?? brainId("req") };
          },
          haltAgent: async (haltCtx, agentId) => {
            // Pause all in-flight intents from the agent, then quarantine it.
            const { paused } = await paymentIntentService.pauseByAgent(haltCtx, agentId);
            let quarantined = false;
            await withTenantScope(pool, haltCtx.tenantId, async (c) => {
              const agent = await findAgent(c, agentId);
              if (agent !== null && agent.state === "active") {
                await transitionAgent(c, agentId, "active", "quarantined");
                quarantined = true;
              }
            });
            return { paused, quarantined };
          },
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
            {
              id: "auto-agent-action",
              applies_to: ["agent_action"],
              when: {},
              execute: "auto",
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
              [
                id,
                req.principal!.tenantId,
                content.version,
                JSON.stringify(content),
                hash,
                req.principal!.id,
              ],
            );
          });

          await audit.emit({
            tenantId: req.principal.tenantId,
            layer: "policy",
            actor: req.principal.id,
            action: "policy.activate",
            inputs: {
              version: content.version,
              policy_hash: hash.toString("hex"),
              demo_bypass: true,
            },
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
          return {
            triggered: true,
            message: "anchor published — check GET /v1/audit/anchor/latest",
          };
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

  // -- Agent-route worker (Phase 1) -----------------------------------
  // Consumes brain.agent.route jobs: route to an agent, then propose through
  // the existing path (never executes). Domain-event producers are still
  // integration markers, so the queue stays idle until they emit. The
  // reconciliation override delegates to the Python agent when configured.
  const agentRouteWorker = createAgentRouteWorker({
    router: agentRouter,
    handlers: internalAgentHandlers,
    definitions: internalAgentDefinitions,
    actionResolver,
    evidence: agentEvidence,
    propose: { agents: agentService, paymentIntents: paymentIntentService },
    agentOverrides,
    redisUrl: cfg.REDIS_URL,
    actor: "agent_router_worker",
  });
  log.info("agent-route worker started");

  // -- listen ---------------------------------------------------------
  await app.listen({ host: "0.0.0.0", port: cfg.PORT });
  log.info({ port: cfg.PORT, version: cfg.SERVICE_VERSION }, "brain-server up");

  // -- graceful shutdown ----------------------------------------------
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutting down");
    anchorShutdown = true;
    if (anchorTimer !== undefined) clearTimeout(anchorTimer);
    normalizeWorker.stop();
    anchorReconciler?.stop();
    try {
      await agentRouteWorker.close();
    } catch (err) {
      log.error({ err }, "agentRouteWorker.close failed");
    }
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
