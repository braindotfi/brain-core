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
import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
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
  RedisSlidingWindowRateLimiter,
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
  buildCredentialKeyProvider,
  withTenantScope,
  createRoutingEnqueue,
  isDomainEvent,
  isTenantCategory,
  newTokenId,
  newPolicyId,
  newTenantId,
  newUserId,
  newAgentId,
  isBrainId,
  computeAgentScopeHash,
  PAYMENT_AGENT_SCOPES,
  InMemoryAuditEmitter,
  AGENT_PERMITTED_SCOPES,
  type Scope,
  type ServiceCallContext,
  type TenantCategory,
} from "@brain/shared";

import { registerSiwxRoutes, StubAgentRegistry, PostgresAgentRegistry } from "./auth/siwx.js";
import { registerOnboardingRoutes } from "./onboarding/routes.js";
import { registerPasswordLoginRoute, PostgresUserCredentialReader } from "./onboarding/login.js";
import {
  registerWalletRoutes,
  PostgresWalletIdentityReader,
} from "./onboarding/wallet-identities.js";
import { createViemAnchorBroadcaster, createViemAnchorEventReader } from "./anchorBroadcaster.js";
import { logBootCapabilities } from "./capabilities.js";
import { registerProofRoutes, poolProofBuilder } from "./proof/routes.js";
import { TenantDeletionService } from "./tenant-deletion/service.js";
import { startTenantBlobPurgeWorker } from "./tenant-deletion/blob-purge-worker.js";
import { registerTenantDeletionRoute } from "./tenant-deletion/route.js";
import { registerDemoProvisionAnchorRoute } from "./demo/anchor-route.js";
import { registerProofViewRoute } from "./proof/view.js";
import { registerAuditHealthRoute } from "./audit-health/route.js";
import {
  registerOAuthProtectedResourceRoute,
  resourceMetadataUrl,
} from "./well-known/oauth-protected-resource.js";
import { registerDocsRoutes } from "./docs/routes.js";
import { registerSecurityHeaders } from "./security-headers.js";
import { makeRunLoaders } from "./agents/run-loaders.js";

import {
  registerRawPlugin,
  SourceService,
  PostgresSourceRepository,
  startInterpretWorker,
  startSyncWorker,
  assertRegistryPartnerIsolation,
  type RegisterRawPluginOptions,
} from "@brain/raw";

import {
  LedgerService,
  registerLedgerPlugin,
  startNormalizeWorker,
  startLedgerProjectionWorker,
  startLedgerAparProjectionWorker,
} from "@brain/ledger";

import { registerCanonicalRoutes, startCanonicalProjectionWorker } from "@brain/canonical";

import { WikiPageService, registerWikiPlugin, loadRegistry } from "@brain/wiki";

import {
  registerPolicyRoutes,
  PolicyService,
  allowedActionsFor,
  contentHash,
  getActive as policyGetActive,
  getById as policyGetById,
  makeAttestCounterpartyAgent,
  makeSumAgentWindowSpend,
  makeResolveEscrowState,
  makeResolveReputation,
} from "@brain/policy";
import type { PolicyDeps, PolicyDocument, PolicyRow } from "@brain/policy";

import {
  registerExecutionRoutes,
  registerMemberRoutes,
  registerPaymentIntentRoutes,
  ApprovalService,
  ActorResolver,
  OutboxService,
  AgentService,
  PostgresMemberLookup,
  AchPlaidRail,
  OnchainBaseRail,
  X402BaseRail,
  EscrowBaseRail,
  RailRegistry,
  defaultRails,
  startOutboxWorker,
  findAgent,
  insertAgentRun,
  insertRoutingDecision,
  findAgentRun,
  listAgentRuns,
  findRoutingDecision,
  transitionAgent,
  releaseAgentQuarantine,
} from "@brain/execution";
import type { ExecutionDeps, OnchainDispatchParams, Rail } from "@brain/execution";
import { parseEther } from "viem";
import { buildPlaidTransferClient } from "./rails/plaidClient.js";
import { buildOnchainExecutor, getHolderAddress } from "./rails/onchainExecutor.js";
import { buildPolicyRegistrar } from "./policyRegistrar.js";
import { buildX402Client } from "./rails/x402Client.js";

import {
  registerAuditRoutes,
  registerWebhookRoutes,
  publishAnchor,
  startAnchorReconciler,
  startAuditConsistencyVerifier,
  startWebhookDispatchWorker,
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
  ServiceEvidenceGatherer,
  createAgentRouteWorker,
  reindexIntentClassifier,
  registerAgentApiRoutes,
  StaticPromotionPolicy,
  LIVE_AGENTS,
  PostgresSignalsProvider,
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
import {
  createProviderTenantResolver,
  createStripeTenantResolver,
} from "./webhooks/stripeTenant.js";
import { buildRawEvidenceService } from "./adapters/raw-evidence-adapter.js";
import { buildWikiMemoryService } from "./adapters/wiki-memory-adapter.js";
import { buildEvidenceProviders } from "./agents/evidence-providers.js";
import {
  makeResolveAgent,
  makeResolveTenantFlags,
  makeResolveAccount,
  makeResolveCounterparty,
  resolvePrincipalFromCtx,
  makeResolveRole,
  makeIsApproverActive,
  makeResolveSubjectOwnerTenant,
  makeResolveActivePolicyVersion,
  makeInvoiceShortcutResolver,
  makeSumActiveReservations,
  makeResolveEvidence,
  makeDetectDuplicates,
} from "./gate-loaders/index.js";
import { buildPaymentIntentService } from "./composition/payment-intent-service.js";
import { assertDbIsolationFences } from "./composition/db-isolation.js";
import { assertRuntimeDbRoles } from "./composition/runtime-db-roles.js";
import {
  assertDeployedEscrowBytecode,
  assertEscrowAuditApproved,
  readAuditChainApproved,
  readAuditStatusApproved,
  readDeployedBytecodeExpectation,
} from "./composition/escrow-audit-gate.js";
import { makeBaseGetCode } from "./composition/eth-getcode.js";
import { assertAtLeastOneLiveRailInProduction } from "./composition/rails-prod-fence.js";
import { closeAllPools } from "./composition/close-pools.js";
import { runShutdown } from "./composition/shutdown.js";
import { resolveComposition, POOL_ENV } from "./composition/process-roles.js";
import { assertMoneyPathLoadersWiredInProduction } from "./composition/payment-loaders-prod-fence.js";
import { assertDemoProvisionFences } from "./composition/demo-provision-fence.js";
import { assertServiceTokenFences } from "./composition/service-token-fence.js";
import { RAIL_CATALOG, computeRailPostures, type RailName } from "./composition/rail-catalog.js";
import { seedBrainSaasDemo } from "./demo/brainsaas-seed.js";
import { YIELD_VENUES } from "./demo/yield-venues.js";

import type { LedgerDeps } from "@brain/ledger";
import type { WikiDeps, PolicyReader, AgentReader, PolicyView } from "@brain/wiki";
import type { RawDeps } from "@brain/raw";
import type { GatePaymentIntent, TenantScopedClient } from "@brain/shared";

const DEMO_MEMBER_SESSION_SCOPES = [
  "ledger:read",
  "wiki:read",
  "raw:read",
  "policy:read",
  "execution:read",
  "execution:admin",
  "payment_intent:approve",
  "audit:read",
] as const satisfies readonly Scope[];

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

  // Process role (worker/process separation): which of the /v1 API surface,
  // background-worker groups, and least-privilege role pools this process runs.
  // Defaults (HTTP on + all workers) reproduce the all-in-one process.
  const composition = resolveComposition({
    httpEnabled: cfg.BRAIN_HTTP_ENABLED,
    workers: cfg.BRAIN_WORKERS,
  });
  log.info(
    { httpEnabled: composition.httpEnabled, workers: [...composition.workers].sort() },
    "process role resolved",
  );

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
  // Fail-closed in NODE_ENV=production for both DB-isolation URLs; warn
  // in dev/test. Logic + tests live in composition/db-isolation.ts.
  // Only fence the URLs this process role actually needs (worker/process
  // separation): an api-only or single-worker process must not require the
  // other roles' URLs. requireWiki only when serving the /v1 Wiki routes.
  assertDbIsolationFences({
    nodeEnv: cfg.NODE_ENV,
    wikiDbUrl: cfg.BRAIN_WIKI_DB_URL,
    requireWiki: composition.httpEnabled,
    requiredEnv: new Set([...composition.pools].map((p) => POOL_ENV[p])),
    privilegedRoleUrls: {
      BRAIN_RAW_WORKER_DB_URL: cfg.BRAIN_RAW_WORKER_DB_URL,
      BRAIN_CANONICAL_PROJECTOR_DB_URL: cfg.BRAIN_CANONICAL_PROJECTOR_DB_URL,
      BRAIN_LEDGER_PROJECTOR_DB_URL: cfg.BRAIN_LEDGER_PROJECTOR_DB_URL,
      BRAIN_EXECUTION_WORKER_DB_URL: cfg.BRAIN_EXECUTION_WORKER_DB_URL,
      BRAIN_AUDIT_VERIFIER_DB_URL: cfg.BRAIN_AUDIT_VERIFIER_DB_URL,
      BRAIN_AUDIT_PUBLISHER_DB_URL: cfg.BRAIN_AUDIT_PUBLISHER_DB_URL,
      BRAIN_RESOLVER_DB_URL: cfg.BRAIN_RESOLVER_DB_URL,
      BRAIN_TENANT_DELETION_DB_URL: cfg.BRAIN_TENANT_DELETION_DB_URL,
    },
  });

  // Partner-connector in-process isolation: refuse to boot if a partner-tier
  // connector (authored outside Brain's trust boundary) has an in-process
  // SourceAdapter, a Ledger parser, or webhook delivery registered. Structural
  // invariant (not env-gated); a no-op while every connector is first-party.
  assertRegistryPartnerIsolation();

  // Refuse to boot against Base mainnet (chainId=8453) with BRAIN_ESCROW_ADDRESS
  // configured unless BOTH the committed audit record (contracts/audit-status.json
  // status "approved", R-01) AND an operator env attestation are present. Silent
  // on Base Sepolia + when no escrow is wired. Logic + tests live in
  // composition/escrow-audit-gate.ts.
  assertEscrowAuditApproved({
    chainId: cfg.BRAIN_BASE_CHAIN_ID,
    escrowAddress: cfg.BRAIN_ESCROW_ADDRESS,
    auditApproved: cfg.BRAIN_ESCROW_AUDIT_APPROVED,
    auditStatusApproved: readAuditStatusApproved(),
    auditChainApproved: readAuditChainApproved(cfg.BRAIN_BASE_CHAIN_ID),
    ...(cfg.BRAIN_ESCROW_AUDIT_RECEIPT !== undefined
      ? { auditReceipt: cfg.BRAIN_ESCROW_AUDIT_RECEIPT }
      : {}),
  });

  // On-chain half of the mainnet escrow fence: verify the DEPLOYED escrow
  // bytecode matches the audited runtime bytecode (immutable-masked) via
  // eth_getCode. Only on Base mainnet with an escrow address + a Base RPC
  // configured; silent (early-return inside) otherwise. Runs AFTER the
  // audit-approval fence above, so it is reached only once the audit is
  // approved — the deployed code must then be the code we audited.
  {
    const escrowRpcUrl = cfg.BASE_RPC_URL ?? cfg.RPC_URL;
    if (cfg.BRAIN_ESCROW_ADDRESS !== undefined) {
      const expectation = readDeployedBytecodeExpectation();
      await assertDeployedEscrowBytecode({
        chainId: cfg.BRAIN_BASE_CHAIN_ID,
        escrowAddress: cfg.BRAIN_ESCROW_ADDRESS,
        expectedRuntimeSha256: expectation.expectedRuntimeSha256,
        immutableReferences: expectation.immutableReferences,
        getCode: makeBaseGetCode(escrowRpcUrl, cfg.BRAIN_BASE_CHAIN_ID),
      });
    }
  }

  // Batch 10 C-1: refuse to boot when /v1/demo/provision-run is enabled
  // without (a) the shared-secret header configured (so the route would mint
  // tokens to anyone reaching it) or (b) the testnet attestation in
  // NODE_ENV=production. Logic + tests live in composition/demo-provision-fence.ts.
  assertDemoProvisionFences({
    nodeEnv: cfg.NODE_ENV,
    provisionEnabled: cfg.BRAIN_DEMO_PROVISION_ENABLED,
    provisionSecret: cfg.BRAIN_DEMO_PROVISION_SECRET,
    testnetAttested: cfg.BRAIN_DEMO_PROVISION_TESTNET_ATTESTED,
  });

  // Refuse to boot when POST /v1/auth/service-token is enabled without (a) the
  // shared-secret header configured (so the route would mint tokens to anyone
  // reaching it) or (b) the testnet attestation in NODE_ENV=production. Logic +
  // tests live in composition/service-token-fence.ts.
  assertServiceTokenFences({
    nodeEnv: cfg.NODE_ENV,
    serviceTokenEnabled: cfg.BRAIN_SERVICE_TOKEN_ENABLED,
    serviceTokenSecret: cfg.BRAIN_SERVICE_TOKEN_SECRET,
    testnetAttested: cfg.BRAIN_SERVICE_TOKEN_TESTNET_ATTESTED,
  });

  let wikiPool = pool;
  if (cfg.BRAIN_WIKI_DB_URL !== undefined) {
    wikiPool = createPool({
      connectionString: cfg.BRAIN_WIKI_DB_URL,
      max: cfg.DATABASE_POOL_MAX,
      statementTimeoutMs: cfg.DATABASE_STATEMENT_TIMEOUT_MS,
      applicationName: `${cfg.SERVICE_NAME}-wiki`,
    });
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
      "BLOB_BACKEND=memory is not allowed in NODE_ENV=production — set BLOB_BACKEND=azure or BLOB_BACKEND=s3",
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

  // -- blob adapter — azure or s3 in production, memory in local dev ---
  const blob = createBlobAdapter({
    backend: cfg.BLOB_BACKEND,
    container: cfg.BLOB_CONTAINER,
    ...(cfg.AZURE_BLOB_ACCOUNT_NAME !== undefined
      ? { azureAccountName: cfg.AZURE_BLOB_ACCOUNT_NAME }
      : {}),
    ...(cfg.AZURE_BLOB_ACCOUNT_KEY !== undefined
      ? { azureAccountKey: cfg.AZURE_BLOB_ACCOUNT_KEY }
      : {}),
    ...(cfg.S3_ENDPOINT !== undefined ? { s3Endpoint: cfg.S3_ENDPOINT } : {}),
    ...(cfg.S3_REGION !== undefined ? { s3Region: cfg.S3_REGION } : {}),
    ...(cfg.S3_ACCESS_KEY_ID !== undefined ? { s3AccessKeyId: cfg.S3_ACCESS_KEY_ID } : {}),
    ...(cfg.S3_SECRET_ACCESS_KEY !== undefined
      ? { s3SecretAccessKey: cfg.S3_SECRET_ACCESS_KEY }
      : {}),
    s3ForcePathStyle: cfg.S3_FORCE_PATH_STYLE,
  });

  // -- layer deps objects ---------------------------------------------
  const rawDeps: RawDeps = { pool, blob, audit };
  const ledgerDeps: LedgerDeps = { pool, audit };
  const ledgerService = new LedgerService(ledgerDeps);

  // -- source credential store ----------------------------------------
  // Always use PostgresSourceRepository for persistence. The credential-key
  // provider selects between Azure Key Vault (production) and the env-var path
  // (dev/staging); both paths fail closed in production via boot-time guards.
  const credentialKeyProvider = buildCredentialKeyProvider({
    kmsVaultUrl: cfg.BRAIN_AZURE_KEY_VAULT_URL,
    kmsSecretName: cfg.BRAIN_SOURCE_CREDENTIAL_KEY_VAULT_NAME,
    envVarKey: cfg.BRAIN_SOURCE_CREDENTIAL_KEY,
    envKeyId: cfg.BRAIN_SOURCE_CREDENTIAL_KEY_ID,
    nodeEnv: cfg.NODE_ENV,
  });
  const sourceCredential = await credentialKeyProvider.load();
  const postgresSourceRepo = new PostgresSourceRepository({
    pool,
    ...(sourceCredential !== undefined
      ? {
          credentialKey: sourceCredential.key,
          credentialKeyId: sourceCredential.keyId,
        }
      : {}),
  });
  const sourceService = new SourceService(postgresSourceRepo, postgresSourceRepo);

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
    annotationRateLimiter: new RedisSlidingWindowRateLimiter(redis, {
      windowSeconds: 3600,
      limit: cfg.WIKI_ANNOTATION_RATE_PER_HOUR,
    }),
    policyReader,
    agentReader,
  };

  const wikiPageService = new WikiPageService({ pool, audit, embed, policyReader, agentReader });
  const wikiService = buildWikiMemoryService(wikiPageService, wikiDeps, rawDeps);

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

  const policyService = new PolicyService({
    pool,
    audit,
    ...(cfg.BRAIN_REPUTATION_REGISTRY_ADDRESS !== undefined
      ? {
          resolveReputation: makeResolveReputation({
            registryAddress: cfg.BRAIN_REPUTATION_REGISTRY_ADDRESS,
            rpcUrl: cfg.BASE_RPC_URL ?? cfg.RPC_URL,
            chainId: cfg.BRAIN_BASE_CHAIN_ID,
          }),
        }
      : {}),
  });

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

  // P0.4 hardening hooks. Demo mode uses permissive variants so the golden-path
  // auto-signing flow is not blocked by revocation/cross-tenant/staleness checks.
  const isApproverActive = cfg.BRAIN_DEMO_MODE
    ? async (): Promise<boolean> => true
    : makeIsApproverActive(pool);
  const resolveSubjectOwnerTenant = cfg.BRAIN_DEMO_MODE
    ? async (ctx: ServiceCallContext): Promise<string | null> => ctx.tenantId
    : makeResolveSubjectOwnerTenant(pool);
  const resolveActivePolicyVersion = cfg.BRAIN_DEMO_MODE
    ? async (): Promise<number | null> => null
    : makeResolveActivePolicyVersion(pool);

  const approvalService = new ApprovalService({
    pool,
    audit,
    resolveRole,
    isApproverActive,
    resolveSubjectOwnerTenant,
    resolveActivePolicyVersion,
  });
  const memberLookup = new PostgresMemberLookup(pool);
  const actorResolver = new ActorResolver({ members: memberLookup });

  // P0.5: invoice shortcut resolver (LedgerService-backed; works in demo too).
  const invoiceShortcut = makeInvoiceShortcutResolver(ledgerService, pool);

  // Resolve on-chain dispatch params at execute time. Only wired when both the
  // session key and the BrainSmartAccount address are configured. The closure
  // looks up the destination counterparty's aliases for the target address.
  const sessionKey = cfg.BRAIN_SESSION_KEY;
  const smartAccount = cfg.BRAIN_ONCHAIN_SMART_ACCOUNT;
  const resolveOnchainParams:
    | ((
        ctx: ServiceCallContext,
        intent: {
          source_account_id: string;
          destination_counterparty_id: string;
          amount: string;
          currency: string;
        },
      ) => Promise<OnchainDispatchParams | null>)
    | undefined =
    sessionKey !== undefined && smartAccount !== undefined
      ? async (ctx, intent) => {
          const cp = await ledgerService.findCounterpartyById(
            ctx,
            intent.destination_counterparty_id,
          );
          if (cp === null) return null;
          const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;
          const target = cp.aliases.find((a) => ETH_ADDR.test(a));
          if (target === undefined) return null;
          const valueWei =
            intent.currency.toUpperCase() === "ETH" ? parseEther(intent.amount).toString() : "0";
          return {
            smart_account: smartAccount,
            holder: getHolderAddress(sessionKey as `0x${string}`),
            target,
            data: "0x",
            value: valueWei,
            policy_version: cfg.BRAIN_ONCHAIN_POLICY_VERSION,
          };
        }
      : undefined;

  // Resolve Plaid credentials at execute time: look up the ledger account's
  // external_account_id, then call the source service to decrypt credentials.
  const sourceCredentialResolver = {
    async resolve(
      ctx: ServiceCallContext,
      sourceAccountId: string,
    ): Promise<{ credentials: object; source_type: string } | null> {
      const result = await ledgerService.getAccount(ctx, sourceAccountId);
      if (result === null || result.account.external_account_id === null) return null;
      const resolved = await sourceService.resolveCredentialsForAccount(
        ctx,
        result.account.external_account_id,
      );
      if (resolved === null) return null;
      return { credentials: resolved.credentials, source_type: resolved.type };
    },
  };

  // §6 M2M gate loaders — extracted so EVERY PaymentIntentService construction
  // in this file shares the same posture. scripts/check-payment-intent-loaders.mjs
  // enforces that the M2M loaders (5.5 / 8.5) appear at every production site.
  // Loaders are unconditionally wired; gate checks 5.5/8.5 stay dormant only
  // when the policy envelope has no micropayment_window_cap (8.5) or the
  // counterparty is not an agent-type (5.5). Escrow (6.6) is env-gated.
  const attestCounterpartyAgent = makeAttestCounterpartyAgent({
    registryAddress: cfg.MCP_AGENT_REGISTRY_ADDRESS,
    rpcUrl: cfg.BASE_RPC_URL ?? cfg.RPC_URL,
    chainId: cfg.BRAIN_BASE_CHAIN_ID,
  });
  const sumAgentWindowSpend = makeSumAgentWindowSpend(pool);
  const resolveEscrowState =
    cfg.BRAIN_ESCROW_ADDRESS !== undefined
      ? makeResolveEscrowState({
          escrowAddress: cfg.BRAIN_ESCROW_ADDRESS,
          rpcUrl: cfg.BASE_RPC_URL ?? cfg.RPC_URL,
          chainId: cfg.BRAIN_BASE_CHAIN_ID,
        })
      : undefined;

  // §6 core safety loaders (checks 8 / 9.5 / 11.5). Production-mandatory;
  // composition-root parity lint enforces presence at every PI service site.
  const sumActiveReservations = makeSumActiveReservations(pool);
  const resolveEvidence = makeResolveEvidence(pool);
  const detectDuplicates = makeDetectDuplicates(pool);
  // RFC 0004 §5.2: cap a new intent's confidence at the obligation it pays, so
  // document-extracted (<= 0.5) obligations gate via policy. Shared across every
  // PaymentIntentService construction so the cap can never be silently absent at
  // one route mount (C-4); the factory now requires it.
  const resolveObligationConfidence = async (
    ctx: ServiceCallContext,
    obligationId: string,
  ): Promise<number | null> =>
    (await ledgerService.findObligationById(ctx, obligationId))?.confidence ?? null;

  // Batch 10 H-1: §6 gate check 6.7 reads the linked obligation's direction.
  // The closure narrows the row's direction column to the gate's enum and
  // treats anything else (NULL backfill, malformed value) as "unknown",
  // which the gate handles as a pass (no extra check fires).
  const resolveObligationDirection = async (
    ctx: ServiceCallContext,
    obligationId: string,
  ): Promise<"payable" | "receivable" | null> => {
    const row = await ledgerService.findObligationById(ctx, obligationId);
    const d = (row as { direction?: string | null } | null)?.direction ?? null;
    return d === "payable" || d === "receivable" ? d : null;
  };

  // Phase 2 trust contract: the gate's low-trust auto-execution rule (check
  // 9.5) reads the linked obligation's provenance — a reconciliation-
  // corroborated obligation (promoted to `extracted`) keeps document-only
  // evidence eligible for an `allow` outcome.
  const resolveObligationProvenance = async (
    ctx: ServiceCallContext,
    obligationId: string,
  ): Promise<string | null> =>
    (await ledgerService.findObligationById(ctx, obligationId))?.provenance ?? null;
  const resolveApprovalPayeeEmail = async (
    ctx: ServiceCallContext,
    intent: GatePaymentIntent,
  ): Promise<string | null> => {
    const counterparty = await ledgerService.findCounterpartyById(
      ctx,
      intent.destination_counterparty_id,
    );
    return counterparty === null ? null : emailFromMetadata(counterparty.metadata);
  };

  // Production fence: the always-applicable money-path safety loaders must be
  // wired in production. Same fail-closed posture as the rail/escrow fences.
  assertMoneyPathLoadersWiredInProduction({
    nodeEnv: process.env.NODE_ENV,
    hasResolveEvidence: resolveEvidence !== undefined,
    hasDetectDuplicates: detectDuplicates !== undefined,
    hasSumActiveReservations: sumActiveReservations !== undefined,
    hasResolveObligationConfidence: resolveObligationConfidence !== undefined,
    hasResolveObligationDirection: resolveObligationDirection !== undefined,
  });

  // Agent-router routing enqueue (agent-router Phase 1). Shared by the
  // PaymentIntent + reconciliation domain-event producers so events actually
  // reach the brain.agent.route queue the worker drains. Declared before the
  // first PaymentIntentService build so both route mounts share one enqueue.
  const routingEnqueue = createRoutingEnqueue({ redisUrl: cfg.REDIS_URL });

  const paymentIntentService = buildPaymentIntentService({
    pool,
    audit,
    approvals: approvalService,
    actorResolver,
    members: memberLookup,
    resolveAgent,
    resolveTenantFlags,
    resolveAccount,
    resolveCounterparty,
    resolveApprovalPayeeEmail,
    evaluatePolicy: evaluatePaymentIntent,
    resolvePrincipal,
    attestCounterpartyAgent,
    sumAgentWindowSpend,
    sumActiveReservations,
    resolveEvidence,
    detectDuplicates,
    resolveObligationConfidence,
    resolveObligationDirection,
    resolveObligationProvenance,
    ...(resolveEscrowState !== undefined ? { resolveEscrowState } : {}),
    ...(resolveOnchainParams !== undefined ? { resolveOnchainParams } : {}),
    sourceCredentialResolver,
    metrics,
    enqueue: routingEnqueue,
    recordAgentSpend: (client, spend) => policyService.recordAgentSpend(client, spend),
  });

  // Build the live rail registry. When credentials are present the real rails
  // are used; otherwise fall back to dev stubs (which fail closed in production).
  const railsBuild = (() => {
    const configured: Rail[] = [];
    const liveNames: string[] = [];
    if (cfg.PLAID_CLIENT_ID !== undefined && cfg.PLAID_SECRET !== undefined) {
      const plaidClient = buildPlaidTransferClient({
        clientId: cfg.PLAID_CLIENT_ID,
        secret: cfg.PLAID_SECRET,
        env: cfg.PLAID_ENV,
      });
      configured.push(new AchPlaidRail({ client: plaidClient }));
      liveNames.push("bank_ach");
      log.info({ env: cfg.PLAID_ENV }, "ACH Plaid rail registered");
    }
    let onchainExecutor: ReturnType<typeof buildOnchainExecutor> | undefined;
    if (cfg.BRAIN_SESSION_KEY !== undefined && cfg.BASE_RPC_URL !== undefined) {
      onchainExecutor = buildOnchainExecutor({
        privateKey: cfg.BRAIN_SESSION_KEY as `0x${string}`,
        rpcUrl: cfg.BASE_RPC_URL,
        chainId: cfg.BRAIN_BASE_CHAIN_ID,
      });
      configured.push(new OnchainBaseRail({ executor: onchainExecutor }));
      liveNames.push("onchain_base");
      log.info({ chainId: cfg.BRAIN_BASE_CHAIN_ID }, "on-chain Base rail registered");
    }
    if (
      cfg.BRAIN_X402_FACILITATOR_URL !== undefined &&
      cfg.BRAIN_X402_USDC_ADDRESS !== undefined &&
      cfg.BRAIN_SESSION_KEY !== undefined &&
      cfg.BASE_RPC_URL !== undefined
    ) {
      const x402Client = buildX402Client({
        facilitatorUrl: cfg.BRAIN_X402_FACILITATOR_URL,
        usdcAddress: cfg.BRAIN_X402_USDC_ADDRESS,
        network: cfg.BRAIN_X402_NETWORK,
        privateKey: cfg.BRAIN_SESSION_KEY as `0x${string}`,
        rpcUrl: cfg.BASE_RPC_URL,
        chainId: cfg.BRAIN_BASE_CHAIN_ID,
      });
      configured.push(new X402BaseRail({ client: x402Client }));
      liveNames.push("x402_base");
      log.info({ network: cfg.BRAIN_X402_NETWORK }, "x402 Base rail registered");
    }
    if (
      cfg.BRAIN_ESCROW_ADDRESS !== undefined &&
      onchainExecutor !== undefined &&
      cfg.BRAIN_SESSION_KEY !== undefined &&
      cfg.BRAIN_ONCHAIN_SMART_ACCOUNT !== undefined
    ) {
      configured.push(
        new EscrowBaseRail({
          executor: onchainExecutor,
          escrowAddress: cfg.BRAIN_ESCROW_ADDRESS,
          holderAddress: getHolderAddress(cfg.BRAIN_SESSION_KEY as `0x${string}`),
          smartAccount: cfg.BRAIN_ONCHAIN_SMART_ACCOUNT,
        }),
      );
      liveNames.push("escrow_base");
      log.info({ escrowAddress: cfg.BRAIN_ESCROW_ADDRESS }, "escrow Base rail registered");
    }
    if (configured.length === 0) {
      // Fail-closed in production: stubs refuse to settle at dispatch (item 20),
      // but the orchestrator only sees that as a quiet 500 wave. Boot-fail
      // instead so the misconfiguration surfaces as CrashLoopBackoff. In
      // dev/test, fall through to stubs as before.
      assertAtLeastOneLiveRailInProduction({
        nodeEnv: cfg.NODE_ENV,
        liveRailCount: 0,
      });
      log.warn("no real payment rails configured — falling back to dev stubs");
      // Default stubs (see defaultRails()) — three keys.
      return {
        rails: defaultRails(),
        entries: [
          { name: "bank_ach", live: false },
          { name: "erp_writeback", live: false },
          { name: "onchain_base", live: false },
        ],
      };
    }
    return {
      rails: new RailRegistry(configured),
      entries: liveNames.map((name) => ({ name, live: true })),
    };
  })();
  const rails: RailRegistry = railsBuild.rails;

  const executionDeps: ExecutionDeps = {
    pool,
    audit,
    rails,
    evaluatePolicy: evaluateLegacyPolicy,
    evaluatePaymentIntent,
    resolveAgent,
    resolveTenantFlags,
    resolveAccount,
    resolveCounterparty,
    resolvePrincipal,
    resolveRole,
    isApproverActive,
    resolveSubjectOwnerTenant,
    resolveActivePolicyVersion,
    resolveInvoiceShortcut: invoiceShortcut,
  };

  // Least-privilege cross-tenant pools (replace the single broad brain_privileged
  // pool). Each connects as its own BYPASSRLS role scoped to one layer's tables
  // (infra/db-roles.sql §4). Falls back to the main pool in dev/test with a
  // warning; production presence is fenced above by assertDbIsolationFences.
  const makeRolePool = (url: string | undefined, suffix: string): typeof pool =>
    url === undefined
      ? pool
      : createPool({
          connectionString: url,
          max: 3,
          statementTimeoutMs: cfg.DATABASE_STATEMENT_TIMEOUT_MS,
          applicationName: `${cfg.SERVICE_NAME}-${suffix}`,
        });

  const rawWorkerPool = makeRolePool(cfg.BRAIN_RAW_WORKER_DB_URL, "raw-worker");
  const canonicalProjectorPool = makeRolePool(
    cfg.BRAIN_CANONICAL_PROJECTOR_DB_URL,
    "canonical-projector",
  );
  const ledgerProjectorPool = makeRolePool(cfg.BRAIN_LEDGER_PROJECTOR_DB_URL, "ledger-projector");
  const executionWorkerPool = makeRolePool(cfg.BRAIN_EXECUTION_WORKER_DB_URL, "execution-worker");
  const auditVerifierPool = makeRolePool(cfg.BRAIN_AUDIT_VERIFIER_DB_URL, "audit-verifier");
  const auditPublisherPool = makeRolePool(cfg.BRAIN_AUDIT_PUBLISHER_DB_URL, "audit-publisher");
  const resolverPool = makeRolePool(cfg.BRAIN_RESOLVER_DB_URL, "resolver");
  const tenantDeletionPool = makeRolePool(cfg.BRAIN_TENANT_DELETION_DB_URL, "tenant-deletion");

  await assertRuntimeDbRoles({
    nodeEnv: cfg.NODE_ENV,
    composition,
    pools: {
      request: pool,
      rawWorker: rawWorkerPool,
      canonicalProjector: canonicalProjectorPool,
      ledgerProjector: ledgerProjectorPool,
      executionWorker: executionWorkerPool,
      auditVerifier: auditVerifierPool,
      auditPublisher: auditPublisherPool,
      resolver: resolverPool,
      tenantDeletion: tenantDeletionPool,
      wiki: wikiPool,
    },
    log: (msg, ctx) => log.info(ctx, msg),
  });

  // Outbox drain claims/marks execution_outbox cross-tenant on the execution
  // role; the per-row settle re-enters tenant scope on brain_app separately.
  const withPrivileged = async <T>(
    fn: (client: Pick<TenantScopedClient, "query">) => Promise<T>,
  ): Promise<T> => {
    const pgClient = await executionWorkerPool.connect();
    try {
      return await fn(pgClient as unknown as Pick<TenantScopedClient, "query">);
    } finally {
      pgClient.release();
    }
  };

  const outboxWorker = composition.workers.has("execution")
    ? startOutboxWorker(
        {
          outbox: new OutboxService(),
          rails,
          executor: paymentIntentService,
          audit,
          withPrivileged,
          workerId: `outbox-worker-${process.pid}`,
        },
        { intervalMs: 1_000 },
      )
    : undefined;
  if (outboxWorker !== undefined) log.info("outbox worker started");

  // Item 13: drain webhook_dead_letters with exponential backoff so failed
  // deliveries retry without /replay being invoked manually. The first inline
  // dispatch attempt still happens in WebhookDispatcher; this worker handles
  // attempts 2..MAX and emits the dlq.count metric + exhausted audit event on
  // hard giveup.
  const webhookDispatchWorker = composition.workers.has("webhook")
    ? startWebhookDispatchWorker(
        {
          pool,
          audit,
          metrics,
          workerId: `webhook-dispatch-worker-${process.pid}`,
        },
        { intervalMs: 5_000 },
      )
    : undefined;
  if (webhookDispatchWorker !== undefined) log.info("webhook dispatch worker started");

  // RFC 0003: drain the durable tenant blob purge queue. Jobs belong to
  // already-deleted tenants, so the worker uses the privileged (BYPASSRLS) pool
  // and erases the Raw bytes via the configured BlobAdapter, with bounded
  // retries + a dead-letter state. Harmless when idle.
  const tenantBlobPurgeWorker = composition.workers.has("blob_purge")
    ? startTenantBlobPurgeWorker(
        {
          privilegedPool: tenantDeletionPool,
          blob,
          audit,
          metrics,
          workerId: `tenant-blob-purge-worker-${process.pid}`,
        },
        { intervalMs: 30_000 },
      )
    : undefined;
  if (tenantBlobPurgeWorker !== undefined) log.info("tenant blob purge worker started");

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
    composition.workers.has("audit") &&
    cfg.AUDIT_ANCHOR_ADDRESS !== undefined &&
    anchorRpcUrl !== undefined
      ? startAnchorReconciler({
          pool,
          audit,
          reader: createViemAnchorEventReader({
            contractAddress: cfg.AUDIT_ANCHOR_ADDRESS as `0x${string}`,
            rpcUrl: anchorRpcUrl,
          }),
        })
      : undefined;

  // Runtime audit-consistency verifier (review doc #2 6.4): a read-only detective
  // control that periodically scans audit_events for per-tenant hash-chain forks
  // or gaps and emits gauges. The emitter's advisory lock prevents new forks;
  // this makes any regression / legacy inconsistency observable.
  // The verifier scans every tenant's chain with no tenant scope set, so it MUST
  // run through the BYPASSRLS privileged pool. On the request-path `pool` (the
  // FORCE-RLS `brain_app` role) the queries would match zero rows and report a
  // permanent false-clean (doc A P1.1).
  const auditConsistencyVerifier = composition.workers.has("audit")
    ? startAuditConsistencyVerifier({
        privilegedPool: auditVerifierPool,
        metrics,
      })
    : undefined;

  // Exposed for POST /v1/demo/anchor/trigger — set when anchorBroadcaster is configured.
  let triggerAnchor: (() => Promise<void>) | undefined;
  const policyRegistrar =
    cfg.BRAIN_SESSION_KEY !== undefined &&
    cfg.POLICY_REGISTRY_ADDRESS !== undefined &&
    (cfg.BASE_RPC_URL ?? cfg.RPC_URL) !== undefined
      ? buildPolicyRegistrar({
          privateKey: cfg.BRAIN_SESSION_KEY as `0x${string}`,
          rpcUrl: (cfg.BASE_RPC_URL ?? cfg.RPC_URL) as string,
          registryAddress: cfg.POLICY_REGISTRY_ADDRESS as `0x${string}`,
        })
      : undefined;

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
      : (() => {
          const scopeChecker = createViemScopeChecker({
            rpcUrl: cfg.BASE_RPC_URL ?? cfg.RPC_URL,
            contractAddress: cfg.MCP_AGENT_REGISTRY_ADDRESS as `0x${string}`,
          });
          // Boot-time registry self-check. `getOnchainScopeHash` fails closed to
          // null on an ABI/layout skew, so a stale MCP_AGENT_REGISTRY_ADDRESS
          // would silently 401 every MCP call (agent_not_registered_onchain)
          // instead of surfacing. Probe once at boot and log loudly on mismatch.
          // Fire-and-forget so a slow RPC never blocks server start.
          void scopeChecker
            .selfCheck()
            .then((res) => {
              if (res.ok) {
                log.info(
                  { registry: cfg.MCP_AGENT_REGISTRY_ADDRESS },
                  "MCP agent registry self-check passed",
                );
              } else {
                log.error(
                  { registry: cfg.MCP_AGENT_REGISTRY_ADDRESS, reason: res.reason },
                  "MCP agent registry self-check FAILED — getAgent did not decode; " +
                    "every MCP call will 401 (agent_not_registered_onchain). " +
                    "Verify MCP_AGENT_REGISTRY_ADDRESS and the Base RPC URL.",
                );
              }
            })
            .catch((err) => log.error({ err }, "MCP agent registry self-check threw"));
          return new McpAuthVerifier(pool, scopeChecker);
        })();

  const agentService = new AgentService({
    pool,
    audit,
    evaluatePolicy: evaluateLegacyPolicy,
  });

  // H-07 Proof builder (shared with the HTTP /v1/proof/{action_id} route).
  // Hoisted so the MCP brain://proofs/{action_id} resource and the HTTP route
  // resolve byte-identically through the same pipeline.
  const proofBuilder = poolProofBuilder(pool, {
    anchorContractAddress: cfg.AUDIT_ANCHOR_ADDRESS ?? null,
    chain: "base-sepolia",
  });

  const mcpServer = new BrainMcpServer({
    auth: mcpAuthVerifier,
    ledger: ledgerService,
    wiki: wikiService,
    raw: rawEvidenceService,
    paymentIntents: paymentIntentService,
    agentService,
    audit,
    // Item 17: brain://proofs/{action_id} resource is wired through the shared builder.
    buildProof: proofBuilder,
  });

  // -- Agent router (Phase 1) -----------------------------------------
  // Evidence is gathered from the real Ledger + Wiki services (plan A3 / R-26).
  // Context-keyed: an agent's required_evidence is satisfied only when the
  // routing context references concrete objects (account/transaction/
  // counterparty/invoice/obligation ids) or a tenant-level balance — otherwise
  // the bundle stays empty and the agent keeps the notify_only safe default.
  const agentEvidence = new ServiceEvidenceGatherer(
    buildEvidenceProviders({ ledger: ledgerService, wiki: wikiService }),
  );
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
  // Peer review #15: back the router's signals() with real operational data.
  // Mixes success rate, policy rejection rate, agent state, and an optional
  // on-chain reputation pointer into a single 0..1 reputation per
  // (tenant, agent). The router weights reputation at 0.15, so this is a
  // tighten-only signal that never overrides match quality or evidence
  // completeness — same posture as the Policy DSL reputation rule.
  const signalsProvider = new PostgresSignalsProvider({ pool });

  // Per-tenant routing category, read from tenants.category (migration 0005).
  // Cached in-process to avoid a query per route; on a missing row/column or a
  // read error it falls back to "business" so routing always has a
  // deterministic category. A tenant's category changes rarely, so a
  // process-lifetime cache (cleared on restart) is acceptable.
  const tenantCategoryCache = new Map<string, TenantCategory>();
  const resolveTenantCategory = async (tenantId: string): Promise<TenantCategory> => {
    const cached = tenantCategoryCache.get(tenantId);
    if (cached !== undefined) {
      return cached;
    }
    let value: TenantCategory = "business";
    try {
      const category = await withTenantScope(pool, tenantId, async (c) => {
        const { rows } = await c.query<{ category: string }>(
          `SELECT category FROM tenants WHERE id = $1 LIMIT 1`,
          [tenantId],
        );
        return rows[0]?.category;
      });
      if (category !== undefined && isTenantCategory(category)) {
        value = category;
      }
    } catch {
      // Fall back to "business" — routing must never fail on a category read.
      value = "business";
    }
    tenantCategoryCache.set(tenantId, value);
    return value;
  };

  const agentRouter = new AgentRouter({
    catalog: () => internalAgentCatalog,
    classifier: agentClassifier,
    evidence: agentEvidence,
    getScopedCapabilities: () => internalAgentCapabilities,
    getTenantCategory: resolveTenantCategory,
    signals: (agentKey, tenantId) => signalsProvider.load(agentKey, tenantId),
    audit,
  });

  // Picks the action within the selected agent (replaces handler.actions[0]),
  // using the same classifier the router uses for intent_action_map scoring.
  // H-23: the resolver enforces the signed policy's per-agent allowlist via the
  // `isActionAllowed` hook (PolicyDocument.agent_actions + allowedActionsFor in
  // @brain/policy). The hook loads the *requesting tenant's* active signed
  // policy per call (never a boot closure over one tenant's policy — that would
  // be a tenant-isolation bug). Opt-in / non-breaking: enforce only when the
  // tenant's policy declares an `agent_actions` map; absent that map the tenant
  // has not adopted H-23 and an explicit action is accepted if the agent offers
  // it (pre-H-23 behaviour). Once the map is present its fail-closed semantics
  // apply (an unlisted agent gets [] ⇒ every explicit action denied). The hook
  // now gates EVERY resolution source — explicit, event_map, intent_map, and
  // default (Codex 2026-06-05 P1) — not just explicit requests.
  const actionResolver = new ActionResolver({
    classifier: agentClassifier,
    isActionAllowed: async (tenantId, agentKey, action) => {
      if (tenantId === undefined) {
        // Codex P1 follow-up: a tenant-owned agent run must carry a tenant. In
        // production a missing tenant fails CLOSED (deny) rather than skipping
        // the signed allowlist; dev/test keep the pre-H-23 "no tenant ⇒ allow"
        // allowance so unit fixtures without a tenant still resolve.
        return cfg.NODE_ENV !== "production";
      }
      const doc = await policyService.getActiveDocument({
        tenantId,
        actor: "system:action-resolver",
      });
      if (doc === null || doc.agent_actions === undefined) {
        return true; // tenant has not adopted the H-23 allowlist
      }
      return allowedActionsFor(doc, agentKey).includes(action);
    },
    // Codex P1 follow-up: record a policy denial in the audit trail (tenant,
    // agent, candidate action, resolution source) so a refused action is
    // visible, not just surfaced to the caller as missing_action. Skipped when
    // there is no tenant to scope the event to (the prod no-tenant deny above).
    onPolicyDenied: async ({ tenantId, agentKey, action, source }) => {
      if (tenantId === undefined) return;
      await audit.emit({
        tenantId,
        layer: "agent",
        actor: agentKey,
        action: "agent.action.policy_denied",
        inputs: { agent_key: agentKey, action, source },
        outputs: { denied: true },
      });
    },
  });

  // Delegate the reconciliation agent to the Python reconciliation service when
  // RECONCILIATION_AGENT_URL is set; otherwise reconciliation uses the default
  // AgentService. ReconciliationAgentClient is itself an IAgentService.
  //
  // When wired, every request is HMAC-signed via X-Brain-Auth so the Python
  // service can authenticate the caller. In production we refuse to boot if
  // the URL is set without the matching secret — otherwise every reconciliation
  // call would 401 at the Python verifier with the failure invisible until
  // the first request lands.
  const reconciliationAgentUrl = cfg.RECONCILIATION_AGENT_URL;
  if (
    reconciliationAgentUrl !== undefined &&
    cfg.BRAIN_AGENTS_INBOUND_SECRET === undefined &&
    cfg.NODE_ENV === "production"
  ) {
    throw new Error(
      "BRAIN_AGENTS_INBOUND_SECRET is required when RECONCILIATION_AGENT_URL is set in " +
        "NODE_ENV=production. The Python service requires X-Brain-Auth on every request.",
    );
  }
  const agentOverrides =
    reconciliationAgentUrl !== undefined
      ? {
          reconciliation: new ReconciliationAgentClient(
            reconciliationAgentUrl,
            cfg.BRAIN_AGENTS_INBOUND_SECRET !== undefined
              ? { signingSecret: cfg.BRAIN_AGENTS_INBOUND_SECRET }
              : {},
          ),
        }
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
  // Shadow gate shared by BOTH agent entry points (/agents/run + the BullMQ
  // /agents/events worker) so neither can create a financial proposal for a
  // shadowed agent. Shadow-by-default: every agent not promoted in LIVE_AGENTS.
  const isShadowed = (agentId: string): boolean => !promotionPolicy.isLive(agentId);
  const checkRail = (agentId: string, actionType: string): boolean =>
    promotionPolicy.isRailAllowed(agentId, railKindForAction(actionType));
  const agentRunService = new AgentRunService({
    router: agentRouter,
    actionResolver,
    handlers: internalAgentHandlers,
    definitions: internalAgentDefinitions,
    evidence: agentEvidence,
    propose: { agents: agentService, paymentIntents: paymentIntentService },
    store: agentRunStore,
    getTenantCategory: resolveTenantCategory,
    isShadowed,
    checkRail,
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
  // P1.4: strict CSP + security headers (was contentSecurityPolicy:false).
  await registerSecurityHeaders(app, { connectSrc: corsOrigins });
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

  // Worker/process separation: the public HTTP surface (audit-health snapshot +
  // the whole /v1 tree) is registered only when this process serves HTTP. A
  // worker-only process still exposes /health (above) for orchestrator probes.
  if (composition.httpEnabled) {
    // Operator audit-health snapshot (90eade5 doc 5.10): auth + audit:admin, queries
    // the global verifier tables via the privileged pool. Root-mounted (not /v1) so
    // it stays an internal operational surface outside the public OpenAPI contract.
    registerAuditHealthRoute(app, { privilegedPool: auditVerifierPool });

    // OAuth 2.0 protected-resource metadata (RFC 9728) for the MCP surface.
    // Root-mounted + public so the canonical `mcp.brain.fi` host (Caddy proxies
    // `/.well-known/oauth-protected-resource` straight through) advertises where
    // the authorization server lives. The MCP 401 challenge points clients here.
    await app.register(async (child) =>
      registerOAuthProtectedResourceRoute(child, {
        resource: cfg.MCP_PUBLIC_RESOURCE_URL,
        authorizationServers: [cfg.AUTH_ISSUER],
        scopesSupported: [...AGENT_PERMITTED_SCOPES],
      }),
    );

    // Service layer route registrations — all under /v1 to match OpenAPI spec.
    // Raw: also registers content-type parsers + multipart inside registerRawPlugin.
    const rawOpts: RegisterRawPluginOptions = {
      idempotencyStore,
      idempotencyTtlSeconds: cfg.IDEMPOTENCY_TTL_SECONDS,
      sourceRepository: postgresSourceRepo,
      sourceCredentialStore: postgresSourceRepo,
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
      // Stripe endpoint signing (platform-level secret). Absent => the stripe
      // webhook path answers 501 and ingestion relies on the pull modality.
      ...(cfg.STRIPE_WEBHOOK_SECRET !== undefined
        ? { stripeVerify: { signingSecret: cfg.STRIPE_WEBHOOK_SECRET, clockToleranceSeconds: 300 } }
        : {}),
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
        : createProviderTenantResolver({
            plaid: createPlaidTenantResolver(pool),
            stripe: createStripeTenantResolver(resolverPool),
          }),
    };

    // Mount all service routes under /v1 to match Brain_API_Specification.yaml.
    await app.register(
      async (v1) => {
        await v1.register(async (child) => registerRawPlugin(child, rawDeps, rawOpts));
        await v1.register(async (child) =>
          registerLedgerPlugin(child, ledgerDeps, { enqueue: routingEnqueue }),
        );
        await v1.register(async (child) => registerCanonicalRoutes(child, { pool }));
        await v1.register(async (child) => registerWikiPlugin(child, wikiDeps));
        await v1.register(async (child) => registerPolicyRoutes(child, policyDeps));
        await v1.register(async (child) => registerExecutionRoutes(child, executionDeps));
        await v1.register(async (child) => registerMemberRoutes(child, { pool, audit }));
        await v1.register(async (child) => {
          // PaymentIntentService has its own approval sub-service; create a fresh
          // instance scoped to this plugin so it doesn't share mutable state.
          const piApprovals = new ApprovalService({
            pool,
            audit,
            resolveRole,
            isApproverActive,
            resolveSubjectOwnerTenant,
            resolveActivePolicyVersion,
          });
          const piService = buildPaymentIntentService({
            pool,
            audit,
            approvals: piApprovals,
            actorResolver,
            members: memberLookup,
            resolveAgent,
            resolveTenantFlags,
            resolveAccount,
            resolveCounterparty,
            resolveApprovalPayeeEmail,
            evaluatePolicy: evaluatePaymentIntent,
            resolvePrincipal,
            attestCounterpartyAgent,
            sumAgentWindowSpend,
            sumActiveReservations,
            resolveEvidence,
            detectDuplicates,
            resolveObligationConfidence,
            resolveObligationDirection,
            resolveObligationProvenance,
            ...(resolveEscrowState !== undefined ? { resolveEscrowState } : {}),
            ...(resolveOnchainParams !== undefined ? { resolveOnchainParams } : {}),
            sourceCredentialResolver,
            metrics,
            enqueue: routingEnqueue,
            recordAgentSpend: (client, spend) => policyService.recordAgentSpend(client, spend),
          });
          await registerPaymentIntentRoutes(child, piService, invoiceShortcut);
        });
        await v1.register(async (child) => registerAuditRoutes(child, auditDeps));
        // H-20 webhook dead-letter + replay: /v1/webhooks/{endpoint_id}/{dead-letters,replay}.
        await v1.register(async (child) => registerWebhookRoutes(child, { pool }));
        // H-07 Proof API — GET /v1/proof/{action_id}. Flagship trust artifact:
        // one verifiable proof per action, assembled across Ledger/Policy/Audit/Raw.
        // Shared with the H-25 run-history /proof sub-resource below AND with the
        // MCP brain://proofs/{action_id} resource (item 17). `proofBuilder` is
        // hoisted above where the MCP server is constructed; reused here.
        await v1.register(async (child) =>
          registerProofRoutes(child, { buildProof: proofBuilder }),
        );
        // P0.7 human-readable proof viewer — GET /v1/proof/{id}/view → text/html.
        await v1.register(async (child) =>
          registerProofViewRoute(child, { buildProof: proofBuilder }),
        );
        // Public interactive API reference — GET /v1/docs (Scalar UI) +
        // GET /v1/openapi.yaml. Read-only projection of Brain_API_Specification.yaml;
        // route-scoped CSP relaxation lives inside the plugin (docs/routes.ts).
        await v1.register(async (child) => registerDocsRoutes(child));
        // GDPR right-to-erasure. The tenant-deletion role BYPASSes RLS so cross-
        // tenant rows are reachable for cleanup; auth + tenant-match are
        // enforced at the route boundary.
        const tenantDeletionService = new TenantDeletionService({
          privilegedPool: tenantDeletionPool,
          audit,
        });
        await v1.register(async (child) =>
          registerTenantDeletionRoute(child, { service: tenantDeletionService }),
        );
        await v1.register(async (child) =>
          registerMcpRoute(child, mcpServer, {
            skipPrincipalTypeCheck: cfg.BRAIN_MCP_DEV_AUTH_BYPASS,
            // Per-tenant rate limit so a single misbehaving agent cannot crowd
            // out other tenants on the shared MCP surface (peer review).
            tenantRateLimiter: new RedisSlidingWindowRateLimiter(redis, {
              windowSeconds: cfg.BRAIN_MCP_TENANT_RATE_WINDOW_SECONDS,
              limit: cfg.BRAIN_MCP_TENANT_RATE_LIMIT,
            }),
            // RFC 9728 discovery: 401s carry a WWW-Authenticate challenge that
            // points clients at the protected-resource metadata above.
            resourceMetadataUrl: resourceMetadataUrl(cfg.MCP_PUBLIC_RESOURCE_URL),
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
            isShadowed,
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
        // RFC 0002 Phase D: SIWX resolves a wallet linked to a HUMAN owner to an
        // owner JWT (email-or-wallet login). Cross-tenant read ⇒ privileged pool.
        // Always wired — additive and harmless (returns null absent any link, so
        // sign-in falls through to the agent path).
        const walletIdentityReader = new PostgresWalletIdentityReader(resolverPool);
        await v1.register(async (child) =>
          registerSiwxRoutes(child, {
            signer: siwxSigner,
            registry: agentRegistry,
            resolveWalletIdentity: (addr) => walletIdentityReader.resolveByAddress(addr),
            redis,
            ...(cfg.BRAIN_DEMO_MODE ? { demoMode: true } : {}),
          }),
        );

        // Public self-serve onboarding (RFC 0002) — registered ONLY when the flag
        // is on; absent it the routes do not exist. New tenants are sandbox-only
        // and grant no execution capability. The raw verification token is exposed
        // in the response outside production (no email provider wired yet).
        if (cfg.BRAIN_SELF_SERVE_SIGNUP) {
          await v1.register(async (child) =>
            registerOnboardingRoutes(child, {
              pool,
              audit,
              exposeVerificationToken: cfg.NODE_ENV !== "production",
            }),
          );
          // Owner password login → short-lived management JWT. The email→user
          // lookup is cross-tenant, so it uses the brain_privileged pool (the same
          // sanctioned entry point as the SIWX address→agent lookup).
          const credentialReader = new PostgresUserCredentialReader(resolverPool);
          await v1.register(async (child) =>
            registerPasswordLoginRoute(child, {
              resolveUserByEmail: (email) => credentialReader.resolveByEmail(email),
              signer: siwxSigner,
              audit,
              tokenTtlSeconds: 15 * 60,
            }),
          );
          // Authenticated wallet-link route (owner JWT) → wallet_identities.
          await v1.register(async (child) => registerWalletRoutes(child, { pool }));
        }

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
              {
                id: "auto-onchain-tx",
                applies_to: ["onchain_tx"],
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

            const hash = contentHash(content);

            // ── Idempotency: same content hash already active and on-chain ──
            type ExistingRow = {
              id: string;
              version: number;
              onchain_tx: string;
              onchain_version: number;
            };
            const existingReg = await withTenantScope(pool, req.principal.tenantId, async (c) => {
              const res = await c.query<ExistingRow>(
                `SELECT id, version, onchain_tx, onchain_version FROM policies
               WHERE state = 'active' AND content_hash = $1 AND onchain_tx IS NOT NULL
               LIMIT 1`,
                [hash],
              );
              return res.rows[0] ?? null;
            });

            if (existingReg !== null) {
              reply.status(200);
              return {
                policy_id: existingReg.id,
                state: "active",
                version: content.version,
                rules: content.rules,
                onchain_policy_tx: existingReg.onchain_tx,
                onchain_policy_version: existingReg.onchain_version,
                chain: "base-sepolia",
              };
            }

            const id = newPolicyId();

            await withTenantScope(pool, req.principal.tenantId, async (c) => {
              await c.query(
                `UPDATE policies SET state = 'deactivated', deactivated_at = now() WHERE state = 'active'`,
              );
              const versionRes = await c.query<{ next_version: number }>(
                `SELECT COALESCE(MAX(version) + 1, 1) AS next_version FROM policies WHERE tenant_id = $1`,
                [req.principal!.tenantId],
              );
              const nextVersion = versionRes.rows[0]?.next_version ?? 1;
              await c.query(
                `INSERT INTO policies
                 (id, tenant_id, version, content, content_hash, quorum_required,
                  state, created_by, activated_at)
               VALUES ($1,$2,$3,$4,$5,1,'active',$6,now())`,
                [
                  id,
                  req.principal!.tenantId,
                  nextVersion,
                  JSON.stringify(content),
                  hash,
                  req.principal!.id,
                ],
              );
            });

            // ── On-chain policy registration (best-effort) ─────────────────
            let onchainPolicyTx: string | undefined;
            let onchainPolicyVersion: number | undefined;
            if (policyRegistrar !== undefined) {
              try {
                const reg = await policyRegistrar.registerPolicy(req.principal.tenantId, hash);
                onchainPolicyTx = reg.tx_hash;
                onchainPolicyVersion = reg.version;
                await withTenantScope(pool, req.principal.tenantId, async (c) => {
                  await c.query(
                    `UPDATE policies SET onchain_tx = $1, onchain_version = $2 WHERE id = $3`,
                    [onchainPolicyTx, onchainPolicyVersion ?? null, id],
                  );
                });
              } catch (err) {
                log.warn({ err }, "on-chain policy registration failed — demo continues off-chain");
              }
            }

            await audit.emit({
              tenantId: req.principal.tenantId,
              layer: "policy",
              actor: req.principal.id,
              action: "policy.activate",
              inputs: {
                version: content.version,
                policy_hash: hash.toString("hex"),
                demo_bypass: true,
                onchain_tx: onchainPolicyTx ?? null,
              },
              outputs: { policy_id: id, state: "active" },
            });

            reply.status(200);
            return {
              policy_id: id,
              state: "active",
              version: content.version,
              rules: content.rules,
              ...(onchainPolicyTx !== undefined && {
                onchain_policy_tx: onchainPolicyTx,
                onchain_policy_version: onchainPolicyVersion,
                chain: "base-sepolia",
              }),
            };
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

        // ── GET /v1/reference/yield-venues ───────────────────────────────
        // Public DeFi yield-venue catalog — same for every tenant, no truth or
        // tenant coupling, so it is a static reference module served always-on
        // (outside BRAIN_DEMO_MODE and the provisioning flag). Consumed by the
        // BrainSaaS Treasury scenario to split idle cash across venues.
        v1.get(
          "/reference/yield-venues",
          { config: { skipAuth: true, rateLimit: { max: 60, timeWindow: "1 minute" } } },
          async (_req, reply) => {
            reply.status(200);
            return { venues: YIELD_VENUES, chain: "base-sepolia" };
          },
        );

        // ── POST /v1/demo/provision-run ──────────────────────────────────
        // The BrainSaaS "Brain Playground" fresh-tenant-per-run provisioner.
        // Creates a brand-new tenant, seeds the 3-scenario business into it
        // (tenant-scoped via the app role, RLS on, so each run is isolated and
        // the §6 gate's no-duplicate-payment check never collides across runs),
        // and returns a scoped agent JWT the demo runners use to drive one full
        // policy → payment-intent → audit-anchor flow.
        //
        // Auth (batch 10 C-1): no longer skipAuth. Callers MUST send
        // X-Demo-Provision-Auth equal to BRAIN_DEMO_PROVISION_SECRET. The fence
        // above guarantees the secret is present when this branch registers.
        //
        // Scopes (batch 10 C-1): READ + PROPOSE only. The minted token does
        // NOT include payment_intent:execute, audit:admin, or policy:write.
        // Execution and anchor publication run via tenant-scoped service paths,
        // not via the demo token. Removes the "fresh-tenant drain" footgun a
        // leaked playground token would otherwise represent.
        //
        // Prod-capable: gated by BRAIN_DEMO_PROVISION_ENABLED + the boot fence
        // (which requires BRAIN_DEMO_PROVISION_TESTNET_ATTESTED=true in
        // NODE_ENV=production).
        if (cfg.BRAIN_DEMO_PROVISION_ENABLED) {
          // The fence guarantees this is set when provisioning is enabled, but
          // narrow the type for the closure below.
          const provisionSecret = cfg.BRAIN_DEMO_PROVISION_SECRET;
          if (provisionSecret === undefined || provisionSecret.length === 0) {
            throw new Error(
              "internal: BRAIN_DEMO_PROVISION_SECRET missing after fence passed (should be unreachable)",
            );
          }
          v1.post(
            "/demo/provision-run",
            { config: { skipAuth: true, rateLimit: { max: 10, timeWindow: "1 minute" } } },
            async (req, reply) => {
              // Shared-secret header check. skipAuth: true above bypasses JWT
              // verification (provisioning issues a JWT, the caller doesn't have
              // one yet), but the route is NOT public: it requires the operator
              // header. Constant-time comparison so timing doesn't leak the
              // secret a byte at a time.
              const headerRaw = req.headers["x-demo-provision-auth"];
              const provided = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
              const expectedBuf = Buffer.from(provisionSecret, "utf8");
              const providedBuf = Buffer.from(provided ?? "", "utf8");
              const ok =
                providedBuf.length === expectedBuf.length &&
                timingSafeEqual(providedBuf, expectedBuf);
              if (!ok) {
                reply.status(401);
                return {
                  error: {
                    code: "auth_header_invalid",
                    message:
                      "X-Demo-Provision-Auth header missing or does not match BRAIN_DEMO_PROVISION_SECRET",
                    request_id: req.id ?? null,
                    docs_url: "https://docs.brain.fi/build/playground",
                  },
                };
              }

              const PROVISION_TTL_S = 30 * 60; // 30 min, long enough for one run.
              const tenantId = newTenantId();
              const actor = newUserId();

              // Off-the-record seed: provisioning must not pollute the tenant's
              // audit chain (only the run's actions should anchor).
              const seed = await seedBrainSaasDemo(
                pool,
                new InMemoryAuditEmitter(),
                tenantId,
                actor,
              );

              // The agent token acts AS the seeded payment agent (type "agent") so the
              // §6 gate's agent-identity check passes when the run later proposes
              // a payment-intent. Read + propose scopes ONLY. Execute, audit
              // admin, policy write, and member approval scopes are deliberately
              // excluded: the demo agent can propose but cannot approve or settle.
              const agentToken = await siwxSigner.sign({
                id: seed.agentId,
                type: "agent",
                tenantId,
                tokenId: newTokenId(),
                expiresAt: Math.floor(Date.now() / 1000) + PROVISION_TTL_S,
                scopes: PAYMENT_AGENT_SCOPES,
              });

              // The member token is the human/admin session for member and
              // approval workflows. Its subject matches the bootstrap admin
              // member created by seedBrainSaasDemo. Do not add these scopes to
              // the agent token: agents propose, humans approve.
              const memberToken = await siwxSigner.sign({
                id: actor,
                type: "user",
                tenantId,
                tokenId: newTokenId(),
                expiresAt: Math.floor(Date.now() / 1000) + PROVISION_TTL_S,
                scopes: DEMO_MEMBER_SESSION_SCOPES,
              });

              reply.status(201);
              return {
                tenant_id: tenantId,
                agent_id: seed.agentId,
                actor,
                agent_token: agentToken,
                member_token: memberToken,
                token: agentToken,
                tokens: {
                  agent: {
                    token: agentToken,
                    principal_type: "agent",
                    subject: seed.agentId,
                    scopes: PAYMENT_AGENT_SCOPES,
                    use: "propose-only agent workflows",
                  },
                  member: {
                    token: memberToken,
                    principal_type: "user",
                    subject: actor,
                    member_id: actor,
                    scopes: DEMO_MEMBER_SESSION_SCOPES,
                    use: "member, approval, and admin workflows",
                  },
                },
                expires_in: PROVISION_TTL_S,
                scenario: {
                  vendors: seed.vendors,
                  customers: seed.customers,
                  accounts: seed.accounts,
                  ap_invoices: seed.apInvoices,
                  ar_invoices: seed.arInvoices,
                  policy_id: seed.policyId,
                },
              };
            },
          );

          // POST /v1/demo/provision-run/:tenantId/anchor — server-side anchor
          // trigger for the BrainSaaS playground (see demo/anchor-route.ts). Same
          // shared-secret fence as provision-run; anchors the run's audit log
          // on-chain immediately so the demo does not wait for the hourly
          // background publisher. Only meaningful when the broadcaster is wired.
          await registerDemoProvisionAnchorRoute(v1, {
            provisionSecret,
            // Use the app pool (brain_app, FORCE RLS), NOT a BYPASSRLS pool:
            // publishAnchor -> withTenantScope(tenantId) sets app.tenant_id and
            // relies on RLS to scope listEventsForAnchor to this tenant. A
            // BYPASSRLS pool would silently anchor EVERY tenant's events under
            // this one demo tenant. Same pool the /audit/anchor/publish route uses.
            publish:
              anchorBroadcaster === undefined
                ? undefined
                : (input) => publishAnchor(pool, anchorBroadcaster, input),
          });
        }

        // ── POST /v1/auth/service-token ───────────────────────────────────
        // The production counterpart to /v1/demo/provision-run: a TRUSTED
        // backend-for-frontend (e.g. the Brain Finance BFF) mints a scoped JWT
        // for a STABLE per-user tenant. Unlike provision-run it seeds NO demo
        // business data — it idempotently materialises an empty tenant + an
        // active payment agent (keyed on the caller-supplied tenant_id, which
        // the BFF persists per app-user) and mints a token.
        //
        // Auth: skipAuth (it issues a JWT; the caller has none yet) but NOT
        // public — callers MUST send X-Service-Token-Auth equal to
        // BRAIN_SERVICE_TOKEN_SECRET (constant-time compared). The boot fence
        // (assertServiceTokenFences) guarantees the secret is set when enabled.
        //
        // Scopes: READ + PROPOSE + APPROVE only — never payment_intent:execute,
        // audit:admin, or policy:write. Same ceiling as the demo token; real
        // money movement / policy signing stays off this path. Prod-capable,
        // gated by BRAIN_SERVICE_TOKEN_TESTNET_ATTESTED=true in production.
        if (cfg.BRAIN_SERVICE_TOKEN_ENABLED) {
          const serviceTokenSecret = cfg.BRAIN_SERVICE_TOKEN_SECRET;
          if (serviceTokenSecret === undefined || serviceTokenSecret.length === 0) {
            throw new Error(
              "internal: BRAIN_SERVICE_TOKEN_SECRET missing after fence passed (should be unreachable)",
            );
          }
          v1.post(
            "/auth/service-token",
            { config: { skipAuth: true, rateLimit: { max: 30, timeWindow: "1 minute" } } },
            async (req, reply) => {
              // Shared-secret header check (constant-time).
              const headerRaw = req.headers["x-service-token-auth"];
              const provided = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
              const expectedBuf = Buffer.from(serviceTokenSecret, "utf8");
              const providedBuf = Buffer.from(provided ?? "", "utf8");
              const ok =
                providedBuf.length === expectedBuf.length &&
                timingSafeEqual(providedBuf, expectedBuf);
              if (!ok) {
                reply.status(401);
                return {
                  error: {
                    code: "auth_header_invalid",
                    message:
                      "X-Service-Token-Auth header missing or does not match BRAIN_SERVICE_TOKEN_SECRET",
                    request_id: req.id ?? null,
                    docs_url: "https://docs.brain.fi/api-reference/authentication",
                  },
                };
              }

              // Stable per-user tenant id supplied by the BFF (persisted on its
              // side, one per app-user). Optional: on the first call the BFF can
              // omit it and persist the tnt_ id we return. Reject any other shape
              // so a caller cannot smuggle a non-tenant id.
              const bodyTenant = (req.body as { tenant_id?: unknown } | undefined)?.tenant_id;
              let tenantId: string;
              if (bodyTenant === undefined || bodyTenant === null) {
                tenantId = newTenantId();
              } else if (typeof bodyTenant === "string" && isBrainId(bodyTenant, "tnt")) {
                tenantId = bodyTenant;
              } else {
                reply.status(400);
                return {
                  error: {
                    code: "tenant_id_invalid",
                    message: "tenant_id, when provided, must be a tnt_-prefixed Brain id",
                    request_id: req.id ?? null,
                    docs_url: "https://docs.brain.fi/api-reference/authentication",
                  },
                };
              }

              // Idempotently ensure the tenant row + an active payment agent.
              // RLS: the tenants/agents write policies are WITH CHECK (… =
              // app.tenant_id), so both run inside the tenant's scope.
              const smartAccount =
                process.env["BRAIN_ONCHAIN_SMART_ACCOUNT"] ??
                "0x0000000000000000000000000000000000000000";
              const scopeHash = Buffer.from(
                computeAgentScopeHash(PAYMENT_AGENT_SCOPES).slice(2),
                "hex",
              );
              const agentId = await withTenantScope(pool, tenantId, async (c) => {
                // sandbox=TRUE + created_via='self_serve': this tenant is a
                // read/propose/approve sandbox — rails fail closed and it is
                // never auto-promoted to LIVE_AGENTS. Defense in depth for the
                // no-execute ceiling, even if a scope ever leaked.
                await c.query(
                  `INSERT INTO tenants (id, sandbox, created_via) VALUES ($1, TRUE, 'self_serve')
                     ON CONFLICT (id) DO NOTHING`,
                  [tenantId],
                );
                const existing = await c.query<{ id: string }>(
                  `SELECT id FROM agents
                     WHERE display_name = 'BFF Service Agent' AND state = 'active'
                     ORDER BY created_at ASC LIMIT 1`,
                );
                if (existing.rows[0]) return existing.rows[0].id;
                const newId = newAgentId();
                await c.query(
                  `INSERT INTO agents (id, tenant_id, kind, role, display_name, scope_hash, onchain_address, state, registered_at, created_at, contribution_count, quarantine_threshold)
                   VALUES ($1, $2, 'internal', 'payment', 'BFF Service Agent', $3, $4, 'active', now(), now(), 0, 100)`,
                  [newId, tenantId, scopeHash, smartAccount],
                );
                return newId;
              });

              const SERVICE_TOKEN_TTL_S = 60 * 60; // 1 hour
              const token = await siwxSigner.sign({
                id: agentId,
                type: "agent",
                tenantId,
                tokenId: newTokenId(),
                expiresAt: Math.floor(Date.now() / 1000) + SERVICE_TOKEN_TTL_S,
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

              reply.status(201);
              return {
                tenant_id: tenantId,
                agent_id: agentId,
                token,
                expires_in: SERVICE_TOKEN_TTL_S,
              };
            },
          );
        }
      },
      { prefix: "/v1" },
    );
  } // end if (composition.httpEnabled)

  // -- background workers (each gated by its BRAIN_WORKERS group) ------
  const normalizeWorker = composition.workers.has("normalize")
    ? startNormalizeWorker({ pool, audit })
    : undefined;

  // Interpretation (Appendix B mechanism 2): promotes landed structured
  // artifacts (registered source_schema) into raw_parsed, which the
  // normalize worker then promotes to Ledger entities. Cross-tenant poll,
  // hence the raw-worker role; per-artifact writes stay tenant-scoped.
  const interpretWorker = composition.workers.has("raw")
    ? startInterpretWorker({ pool: rawWorkerPool, blob, audit })
    : undefined;

  // Canonical projection (ingestion architecture §12, Phase 5): promotes the
  // rich Merge accounting pages (gl_account / journal_entry) that the compact
  // Ledger drops into the canonical domain store. Cross-tenant poll over
  // raw_parsed, hence the canonical-projector role; per-row writes stay scoped.
  const canonicalProjectionWorker = composition.workers.has("canonical")
    ? startCanonicalProjectionWorker({
        pool: canonicalProjectorPool,
        audit,
        metrics,
      })
    : undefined;

  // Ledger chart-of-accounts projection (ingestion architecture §12, Phase 5):
  // keeps ledger_gl_accounts current as canonical_gl_account grows. Cross-tenant
  // poll over canonical, hence the ledger-projector role; upserts stay scoped.
  const ledgerProjectionWorker = composition.workers.has("ledger")
    ? startLedgerProjectionWorker({ pool: ledgerProjectorPool })
    : undefined;

  // Ledger AP/AR projection (Phase 5 cutover): obligations + counterparties for
  // Merge-sourced data now project from canonical (the extractor no longer
  // writes them directly). Cross-tenant poll, hence the ledger-projector role.
  const ledgerAparProjectionWorker = composition.workers.has("ledger")
    ? startLedgerAparProjectionWorker({
        pool: ledgerProjectorPool,
        metrics,
      })
    : undefined;

  // Authenticated incremental pull (ingestion architecture §10). The
  // cross-tenant source poll needs BYPASSRLS, hence the raw-worker role; all
  // per-partition ingest writes stay tenant-scoped. Credentials are resolved
  // narrowly per partition run via the encrypted source-credential store.
  const syncWorker = composition.workers.has("raw")
    ? startSyncWorker({
        pool: rawWorkerPool,
        blob,
        audit,
        resolveCredentials: (tenantId, sourceId) =>
          postgresSourceRepo.resolveCredentials(tenantId, sourceId),
      })
    : undefined;

  let anchorTimer: NodeJS.Timeout | undefined;
  let anchorShutdown = false;

  // The scheduled cross-tenant anchor publisher is part of the "audit" worker
  // group (the demo trigger endpoint, when HTTP is on, drives runAnchor too).
  if (composition.workers.has("audit") && anchorBroadcaster !== undefined) {
    const intervalMs = cfg.AUDIT_ANCHOR_INTERVAL_MS;
    let anchorRunning = false;

    const runAnchor = async (): Promise<void> => {
      if (anchorRunning) return;
      anchorRunning = true;
      const now = new Date();
      const periodStart = new Date(now.getTime() - intervalMs);
      try {
        // Cross-tenant ENUMERATION only: MUST use a BYPASSRLS pool (the
        // audit-publisher role, scoped to SELECT on audit_events). The app pool
        // connects as brain_app under FORCE RLS, so without a tenant scope this
        // DISTINCT returns zero rows and the scheduled anchor would silently
        // never fire in production (the manual endpoint works because it is
        // request-scoped to a tenant).
        const res = await auditPublisherPool.query<{ tenant_id: string }>(
          "SELECT DISTINCT tenant_id FROM audit_events WHERE created_at >= $1",
          [periodStart],
        );
        for (const row of res.rows) {
          try {
            // Per-tenant PUBLISH goes through the RLS-enforced app `pool`, NOT
            // the privileged pool. publishAnchor scopes events via
            // withTenantScope(tenantId) + RLS — but RLS is inert for the
            // BYPASSRLS brain_privileged role, so listEventsForAnchor (which
            // filters only by created_at) would return EVERY tenant's events,
            // giving each tenant's anchor an inflated event_count and a Merkle
            // root mixed across tenants. brain_app (NOBYPASSRLS, FORCE RLS)
            // makes withTenantScope actually isolate, matching the manual
            // POST /v1/audit/anchor/publish route. (§1 principle 2: tenant
            // isolation at the storage layer, not a query-layer tenant_id filter.)
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
  const agentRouteWorker = composition.workers.has("agent_route")
    ? createAgentRouteWorker({
        router: agentRouter,
        handlers: internalAgentHandlers,
        definitions: internalAgentDefinitions,
        actionResolver,
        evidence: agentEvidence,
        propose: { agents: agentService, paymentIntents: paymentIntentService },
        // Same shadow gate as /agents/run — a shadowed agent's financial proposal
        // terminates as shadow_completed and creates no PaymentIntent.
        isShadowed,
        checkRail,
        agentOverrides,
        redisUrl: cfg.REDIS_URL,
        actor: "agent_router_worker",
      })
    : undefined;
  if (agentRouteWorker !== undefined) log.info("agent-route worker started");

  // -- capability snapshot (item 5) ------------------------------------
  // One structured log line that answers "what's actually wired in this
  // process?" so demo prelude / ops don't have to spelunk through this file.
  // Rail postures (rec #7) come from the static RAIL_CATALOG + boot config;
  // the boot path supplies the set of names it actually registered live.
  const liveRailNames = new Set<RailName>(
    railsBuild.entries
      .filter((e) => e.live)
      .map((e) => e.name as RailName)
      .filter((n): n is RailName =>
        ["bank_ach", "onchain_base", "x402_base", "escrow_base", "erp_writeback"].includes(n),
      ),
  );
  const railPostures = computeRailPostures(RAIL_CATALOG, cfg, liveRailNames);
  logBootCapabilities(
    {
      nodeEnv: cfg.NODE_ENV,
      rails: railPostures,
      gateLoaders: {
        // attestCounterpartyAgent + sumAgentWindowSpend are unconditionally wired
        // above; resolveEscrowState is opt-in by BRAIN_ESCROW_ADDRESS. Mirror that.
        resolveTenantFlags: resolveTenantFlags !== undefined,
        attestCounterpartyAgent: true,
        sumAgentWindowSpend: true,
        resolveEscrowState: cfg.BRAIN_ESCROW_ADDRESS !== undefined,
        // P1 set: §6 checks 8 / 11 / 11.5 — unconditionally wired (see line 581).
        sumActiveReservations: true,
        resolveEvidence: true,
        detectDuplicates: true,
      },
      liveAgentsCount: Object.keys(LIVE_AGENTS.liveAgents ?? {}).length,
      webhookDispatchWorker: true,
      tenantBlobPurgeWorker: true,
      auditAnchorBroadcaster: anchorBroadcaster !== undefined,
      mcpProofBuilder: true,
      sourceCredentialEncryption: sourceCredential !== undefined,
      sourceCredentialKeyProvider: credentialKeyProvider.source,
      // Storage isolation: BRAIN_WIKI_DB_URL + the eight §4 role URLs set ⇒
      // dedicated least-privilege roles in front of Wiki + every cross-tenant
      // operation. Required true in production by assertDbIsolationFences.
      wikiDbIsolation: cfg.BRAIN_WIKI_DB_URL !== undefined,
      privilegedDbIsolation: [
        cfg.BRAIN_RAW_WORKER_DB_URL,
        cfg.BRAIN_CANONICAL_PROJECTOR_DB_URL,
        cfg.BRAIN_LEDGER_PROJECTOR_DB_URL,
        cfg.BRAIN_EXECUTION_WORKER_DB_URL,
        cfg.BRAIN_AUDIT_VERIFIER_DB_URL,
        cfg.BRAIN_AUDIT_PUBLISHER_DB_URL,
        cfg.BRAIN_RESOLVER_DB_URL,
        cfg.BRAIN_TENANT_DELETION_DB_URL,
      ].every((u) => u !== undefined),
      // Python brain-agents inbound auth (peer-review batch 2, P1+P2).
      // The Python side fails closed in production; this flag surfaces whether
      // we're signing on the way out.
      pythonAgentSigning: cfg.BRAIN_AGENTS_INBOUND_SECRET !== undefined,
    },
    log,
  );

  // -- listen ---------------------------------------------------------
  await app.listen({ host: "0.0.0.0", port: cfg.PORT });
  log.info({ port: cfg.PORT, version: cfg.SERVICE_VERSION }, "brain-server up");

  // -- graceful shutdown ----------------------------------------------
  // Orchestration + the unclean-exit decision live in the runShutdown
  // coordinator (testable). Idempotent via a shared promise so concurrent
  // SIGINT+SIGTERM run the sequence once. A worker that times out instead of
  // draining makes the shutdown unclean and the process exits non-zero (Codex
  // fca9ac8 P2 #5).
  const WORKER_DRAIN_MS = 10_000;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutdownPromise = (async () => {
      log.info({ signal }, "shutting down");
      anchorShutdown = true;
      if (anchorTimer !== undefined) clearTimeout(anchorTimer);

      const outcome = await runShutdown({
        // Only the workers this process actually started (worker/process
        // separation); the rest are undefined and filtered out.
        workers: [
          normalizeWorker,
          interpretWorker,
          canonicalProjectionWorker,
          ledgerProjectionWorker,
          ledgerAparProjectionWorker,
          syncWorker,
          outboxWorker,
          webhookDispatchWorker,
          tenantBlobPurgeWorker,
          auditConsistencyVerifier,
          anchorReconciler,
        ].filter((w): w is NonNullable<typeof w> => w !== undefined),
        workerDrainMs: WORKER_DRAIN_MS,
        closeApp: () => app.close(),
        closeAgentRouteWorker: () => agentRouteWorker?.close() ?? Promise.resolve(),
        closePools: () =>
          closeAllPools([
            pool,
            wikiPool,
            rawWorkerPool,
            canonicalProjectorPool,
            ledgerProjectorPool,
            executionWorkerPool,
            auditVerifierPool,
            auditPublisherPool,
            resolverPool,
            tenantDeletionPool,
          ]),
        disconnectRedis: () => redis.disconnect(),
        shutdownTracing: () => shutdownTracing(),
        log,
        metrics,
      });
      log.info(
        { clean: outcome.clean, timedOutWorkers: outcome.timedOutWorkers },
        "shutdown complete",
      );
      process.exit(outcome.exitCode);
    })();
    return shutdownPromise;
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

function emailFromMetadata(metadata: Record<string, unknown>): string | null {
  for (const value of Object.values(metadata)) {
    if (value !== null && typeof value === "object") {
      const email = (value as { email?: unknown }).email;
      if (typeof email === "string" && email.includes("@")) return email.toLowerCase();
    }
  }
  const email = metadata["email"];
  return typeof email === "string" && email.includes("@") ? email.toLowerCase() : null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
