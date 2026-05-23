# Boot Binary Specification, `services/api/src/main.ts`

Author: feature/mcp-server (post-merge to `main`)
Status: spec, implementation deferred to next branch
Audience: the engineer (likely the CTO) who will close gap #1 from
`docs/v0.3-deliverables.md` so a live PoC can run.

## Why This Exists

The repo today has six service workspaces, `@brain/raw`,
`@brain/ledger`, `@brain/wiki`, `@brain/policy`, `@brain/execution`,
`@brain/audit`, plus the MCP server `@brain/mcp`. Each exports a
`buildXApp(opts)` Fastify factory that mounts that layer's routes
behind a shared auth / error / request-id plugin stack.

**Nothing composes them.** `services/api/src/index.ts` is a stub that
exports a service-name constant. There is no `main.ts`, no `bin`
entry, no Dockerfile target, and no boot site that supplies the
optional `registerMcp` callback to `buildExecutionApp`, which means
every deployed instance returns 404 on `POST /agents/mcp`.

This spec describes the binary that closes that gap. After it lands:

- A single process serves every Brain HTTP surface on one port.
- `POST /agents/mcp` routes to the MCP server.
- `infra/main.tf` Container Apps have a real image to run.
- `pnpm install && pnpm run typecheck` exercises every workspace
  end-to-end (incidentally surfacing gap #4 from the deliverables
  report, typecheck has never been run).

## Architecture Choice

Single-process Fastify on a single port. Each layer mounts its
routes as a Fastify plugin under the root app. Shared plugins
register **once** at the root.

```
process: brain-server
└── Fastify root  (PORT, default 3000)
    ├── requestIdPlugin                (sets x-request-id)
    ├── errorHandlerPlugin             (Brain → JSON-RPC + ProblemDetails)
    ├── authPlugin                     (JwtVerifier)
    ├── idempotencyPlugin              (Redis-backed store)
    ├── GET /health
    │
    ├── plugin: rawRoutes              → /raw/*
    ├── plugin: ledgerRoutes           → /ledger/*
    ├── plugin: wikiRoutes             → /wiki/*, /memory/*
    ├── plugin: policyRoutes           → /policy/*
    ├── plugin: executionRoutes        → /execution/*, /payment-intents/*
    ├── plugin: auditRoutes            → /audit/*
    └── plugin: mcpRoute               → /agents/mcp
```

Why single-process: PoC simplicity. Multi-process + reverse proxy
is post-MVP and changes nothing about the wire contract. Each
layer's routes are encapsulated, so splitting later is a packaging
change, not a re-architecture.

## Required Refactor: `register*Routes` Exports per Service

Today each service's `server.ts` exports only `buildXApp(opts)`,
which constructs _its own_ Fastify instance with shared plugins.
Composing multiple FastifyInstances is awkward; composing **plugins
that register routes onto a parent app** is the standard Fastify
pattern.

For each of the six service workspaces, add one new export:

```ts
// services/<layer>/src/server.ts (NEW, additive)
export async function registerXRoutes(
  app: FastifyInstance,
  deps: XDeps,
): Promise<void> {
  // exact body of the existing route registration calls in
  // buildXApp, minus any shared-plugin (.register(authPlugin), etc.)
  // calls, those are owned by the root.
  app.get("/x/foo", ...);
  app.post("/x/bar", ...);
  // ...
}
```

The existing `buildXApp(opts)` becomes a thin wrapper used only by
unit tests:

```ts
export async function buildXApp(opts: BuildXAppOptions) {
  const app = Fastify(/* ... */);
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, { verifier: opts.jwtVerifier });
  app.get("/health", { config: { skipAuth: true } }, async () => ({ ok: true }));
  await registerXRoutes(app, opts.deps);
  return app;
}
```

Mechanical refactor. ~30 LOC per service × 6 services = ~180 LOC.
**No behavior change for existing tests.**

`services/execution/src/server.ts` already has a private
`registerExecutionRoutes(app, deps)`, just export it.

## Boot Binary: `services/api/src/main.ts`

This is the new binary. ~200 LOC, all wiring.

```ts
#!/usr/bin/env node
import Fastify from "fastify";
import { Pool } from "pg";
import {
  authPlugin,
  errorHandlerPlugin,
  requestIdPlugin,
  idempotencyPlugin,
  JwtVerifier,
  PostgresAuditEmitter,
  RedisIdempotencyStore,
  RedisRevocationStore,
  createLogger,
  redisConnectionFromUrl,
} from "@brain/api/shared";

import { registerRawRoutes } from "@brain/raw";
import { registerLedgerRoutes, LedgerService } from "@brain/ledger";
import { registerWikiRoutes, WikiPageService, askWiki } from "@brain/wiki";
import { registerPolicyRoutes, PolicyService } from "@brain/policy";
import {
  registerExecutionRoutes,
  PaymentIntentService,
  ApprovalService,
  defaultRails,
} from "@brain/execution";
import { registerAuditRoutes, AuditService } from "@brain/audit";
import { BrainMcpServer, McpAuthVerifier, registerMcpRoute } from "@brain/mcp";

import { loadConfig } from "./config.js";
import { buildRawEvidenceService } from "./adapters/raw-evidence.js";
import { buildOnchainScopeChecker } from "./adapters/onchain-scope.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger({ level: cfg.LOG_LEVEL });

  // -- shared infra --------------------------------------------------
  const pool = new Pool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.PG_POOL_MAX,
  });
  const redis = redisConnectionFromUrl(cfg.REDIS_URL);
  const audit = new PostgresAuditEmitter({ pool });
  const jwt = new JwtVerifier({
    issuer: cfg.JWT_ISSUER,
    audience: cfg.JWT_AUDIENCE,
    jwksUri: cfg.JWKS_URI,
    revocationStore: new RedisRevocationStore({ redis }),
  });

  // -- layer services ------------------------------------------------
  const ledger = new LedgerService({ pool, audit });
  const wiki = new WikiPageService({ pool, ledger /*, llm/embeddings deps */ });
  const raw = buildRawEvidenceService({ pool, audit /*, blob, queue */ });
  const policy = new PolicyService({ pool, audit });
  const auditService = new AuditService({ pool });

  const approvals = new ApprovalService({
    pool,
    audit,
    resolveRole: async (id) => {
      // lookup against agents / users tables, TODO
      return "unknown";
    },
  });
  const paymentIntents = new PaymentIntentService({
    pool,
    audit,
    rails: defaultRails(cfg),
    approvals,
    resolveAgent: async (id) => {
      /* ... */
    },
    resolveAccount: async (id) => {
      /* ... */
    },
    resolveCounterparty: async (id) => {
      /* ... */
    },
    evaluatePolicy: policy.evaluatePaymentIntent.bind(policy),
    resolvePrincipal: async (jwtPayload) => {
      /* ... */
    },
  });

  // -- MCP -----------------------------------------------------------
  const mcpAuth = new McpAuthVerifier({
    pool,
    onchain: buildOnchainScopeChecker({
      rpcUrl: cfg.BASE_RPC_URL,
      registry: cfg.BRAIN_MCP_AGENT_REGISTRY_ADDR,
      cacheTtlSec: 60,
    }),
  });
  const mcp = new BrainMcpServer({
    auth: mcpAuth,
    ledger,
    wiki,
    raw,
    paymentIntents,
    audit,
    // agentService: optional, soft-degrades to audit-only stub
  });

  // -- Fastify root --------------------------------------------------
  const app = Fastify({ logger: log, bodyLimit: 1024 * 1024 });
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, { verifier: jwt });
  await app.register(idempotencyPlugin, {
    store: new RedisIdempotencyStore({ redis }),
  });
  app.get("/health", { config: { skipAuth: true } }, async () => ({
    ok: true,
    version: cfg.VERSION,
  }));

  await app.register(async (a) => registerRawRoutes(a, { pool, raw, audit }));
  await app.register(async (a) => registerLedgerRoutes(a, { pool, ledger, audit }));
  await app.register(async (a) => registerWikiRoutes(a, { pool, wiki, ask: askWiki, audit }));
  await app.register(async (a) => registerPolicyRoutes(a, { pool, policy, audit }));
  await app.register(async (a) =>
    registerExecutionRoutes(a, {
      pool,
      audit,
      paymentIntents,
      approvals,
      /* legacy proposal/execution deps */
    }),
  );
  await app.register(async (a) => registerAuditRoutes(a, { pool, auditService }));
  await app.register(async (a) => registerMcpRoute(a, mcp));

  // -- listen + graceful shutdown ------------------------------------
  await app.listen({ host: "0.0.0.0", port: cfg.PORT });
  log.info({ port: cfg.PORT, version: cfg.VERSION }, "brain-server up");

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
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
```

## Config: `services/api/src/config.ts`

```ts
import { z } from "zod";

const Schema = z.object({
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  VERSION: z.string().default("0.3.0"),

  DATABASE_URL: z.string().url(),
  PG_POOL_MAX: z.coerce.number().default(10),

  REDIS_URL: z.string().url(),

  JWT_ISSUER: z.string(),
  JWT_AUDIENCE: z.string(),
  JWKS_URI: z.string().url(),

  BASE_RPC_URL: z.string().url(),
  BRAIN_MCP_AGENT_REGISTRY_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  BRAIN_AUDIT_ANCHOR_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  BRAIN_POLICY_REGISTRY_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/),

  // Optional rails creds (allow missing in dev)
  PLAID_CLIENT_ID: z.string().optional(),
  PLAID_SECRET: z.string().optional(),
  NETSUITE_OAUTH_KEY: z.string().optional(),
  ALCHEMY_API_KEY: z.string().optional(),

  // Anthropic / OpenAI for the LLM stack
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
});

export type AppConfig = z.infer<typeof Schema>;

export function loadConfig(): AppConfig {
  return Schema.parse(process.env);
}
```

## Two Adapters This Binary Needs

These don't exist yet and are part of the boot binary work.

### `services/api/src/adapters/raw-evidence.ts`

`@brain/mcp` and the `/ledger/normalize` route need an
`IRawEvidenceService` (defined in
`shared/src/contracts/IRawEvidenceService.ts`).
`@brain/raw` exports `ingestOne`, `ingestMany`, and adapters but
not a service-shaped object. Wrap them:

```ts
import { ingestOne /* ... */ } from "@brain/raw";
import type { IRawEvidenceService, AuditEmitter } from "@brain/api/shared";
import type { Pool } from "pg";

export function buildRawEvidenceService(deps: {
  pool: Pool;
  audit: AuditEmitter;
  // blob, queue, ...
}): IRawEvidenceService {
  return {
    ingest: (input) => ingestOne(input, deps),
    // implement the remaining IRawEvidenceService methods
  };
}
```

### `services/api/src/adapters/onchain-scope.ts`

`McpAuthVerifier` accepts an `OnchainScopeChecker` dep. No concrete
implementation exists yet, Stage 5 only deployed
`BrainMCPAgentRegistry.sol`; nobody wired the off-chain client.
Implement using ethers:

```ts
import { ethers } from "ethers";
import type { OnchainScopeChecker } from "@brain/mcp";

const ABI = ["function getAgent(bytes32 agentId) view returns (bytes32 scopeHash, bool active)"];

export function buildOnchainScopeChecker(opts: {
  rpcUrl: string;
  registry: string;
  cacheTtlSec: number;
}): OnchainScopeChecker {
  const provider = new ethers.JsonRpcProvider(opts.rpcUrl);
  const contract = new ethers.Contract(opts.registry, ABI, provider);
  const cache = new Map<string, { hash: string; expiresAt: number }>();

  return {
    async getScopeHash(agentId) {
      const cached = cache.get(agentId);
      const now = Date.now();
      if (cached && cached.expiresAt > now) return cached.hash;
      const [hash] = await contract.getAgent(agentIdToBytes32(agentId));
      cache.set(agentId, { hash, expiresAt: now + opts.cacheTtlSec * 1000 });
      return hash;
    },
  };
}
```

## `services/api/package.json` Additions

```json
{
  "name": "@brain/api",
  "type": "module",
  "main": "./dist/index.js",
  "bin": { "brain-server": "./dist/main.js" },
  "scripts": {
    "build": "tsc -b",
    "start": "node dist/main.js",
    "dev": "tsx watch src/main.ts",
    "typecheck": "tsc -b --noEmit"
  },
  "dependencies": {
    "fastify": "^5.0.0",
    "pg": "^8.13.0",
    "ethers": "^6.13.0",
    "zod": "^3.23.0",
    "@brain/raw": "workspace:*",
    "@brain/ledger": "workspace:*",
    "@brain/wiki": "workspace:*",
    "@brain/policy": "workspace:*",
    "@brain/execution": "workspace:*",
    "@brain/audit": "workspace:*",
    "@brain/mcp": "workspace:*"
  }
}
```

## Dockerfile (Project Root)

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY services ./services
COPY tools    ./tools
COPY clients  ./clients
COPY tests    ./tests
RUN pnpm install --frozen-lockfile
RUN pnpm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://localhost:3000/health | grep -q '"ok":true' || exit 1
CMD ["node", "services/api/dist/main.js"]
```

## How to Verify Locally

```bash
pnpm install
pnpm run typecheck                  # exercises every workspace
pnpm run build

# bring up postgres + redis
./scripts/dev-up.sh

# run migrations
DATABASE_URL=postgres://brain:brain@localhost:5432/brain \
  node tools/migrate/dist/cli.js up

# seed the golden path
pnpm -C tools/seed-golden-path run build
DATABASE_URL=postgres://brain:brain@localhost:5432/brain \
BRAIN_TENANT_ID=tnt_01HQ7K3DEMOTENANT \
BRAIN_ACTOR=user_01HQ7K3OPERATOR \
  node tools/seed-golden-path/dist/cli.js

# boot the server
DATABASE_URL=postgres://brain:brain@localhost:5432/brain \
REDIS_URL=redis://localhost:6379 \
JWT_ISSUER=brain.fi \
JWT_AUDIENCE=brain-api \
JWKS_URI=http://localhost:8080/.well-known/jwks.json \
BASE_RPC_URL=https://sepolia.base.org \
BRAIN_MCP_AGENT_REGISTRY_ADDR=0x... \
BRAIN_AUDIT_ANCHOR_ADDR=0x... \
BRAIN_POLICY_REGISTRY_ADDR=0x... \
  pnpm -C services/api run dev

# smoke tests
curl localhost:3000/health
# → {"ok":true,"version":"0.3.0"}

curl -X POST localhost:3000/agents/mcp \
     -H "Authorization: Bearer ${AGENT_JWT}" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
# → JSON-RPC InitializeResult with protocolVersion=2024-11-05
```

## What This Binary Does NOT Do

Out of scope; tracked separately:

1. **Run the Python `services/agents/` workers.** Those are BullMQ
   consumers launched separately by `uv run` from the
   `services/agents/` workspace. Today the workspace is a stub
   (`brain_agents/__init__.py` only), closing that gap is a
   different ticket.
2. **Apply migrations on boot.** Run `tools/migrate` separately.
   Auto-migrate-on-boot is a per-environment policy choice, not a
   binary concern.
3. **Run the audit anchor publisher.** That's a periodic cron job
   (hourly) deployed as its own Container App job, see
   `services/audit/src/publisher.ts`. The shared Postgres pool is
   the only thing they share.
4. **Wire real Plaid / NetSuite / Gmail / Alchemy credentials.**
   Adapters exist; live credentials are a deployment-environment
   concern, not a binary concern.

## Effort Estimate

| Step                                                           | LOC      | Time                                |
| -------------------------------------------------------------- | -------- | ----------------------------------- |
| Add `register*Routes` exports across 6 services                | 6 × ~30  | ~½ day                              |
| Write `services/api/src/main.ts`                               | ~200     | ~½ day                              |
| Write `services/api/src/config.ts`                             | ~50      | ~1 hr                               |
| Write `services/api/src/adapters/raw-evidence.ts`              | ~80      | ~½ day                              |
| Write `services/api/src/adapters/onchain-scope.ts`             | ~50      | ~2 hr                               |
| Update `services/api/package.json` (bin, deps, scripts)        | ~20      | trivial                             |
| Write `Dockerfile`                                             | ~20      | trivial                             |
| Smoke-test `/health` + one MCP `initialize` + one `tools/call` | n/a      | ~½ day                              |
| Surface and fix typecheck errors that show up                  | n/a      | **0–2 days unknown**                |
| **Total**                                                      | **~600** | **~3 days** plus typecheck-fix tail |

The "fix typecheck errors that show up" line is honest, the v0.3
work has never been compiled. There may be import path issues,
missing exports, signature drift across the seven workspaces. None
of those bugs are deep, but they take real time to wade through.

## After This Binary Lands

1. `pnpm install && pnpm run typecheck` runs cleanly across all
   workspaces, closes gap #4 from `docs/v0.3-deliverables.md`.
2. `POST /agents/mcp` is live in any deployed instance, closes
   gap #3 of the MCP feature's "known limitations".
3. `infra/main.tf`'s Container App can target this binary ,
   gap #4 of "live PoC blockers" (no deployed instance) is half
   closed.
4. Every other PoC step that needs "an actual API to talk to"
   becomes reachable. Specifically: an external MCP client
   (Claude Desktop with our connector, or a custom agent) can
   complete the canonical PoC story, read ledger, identify a
   bill, contribute evidence to Raw, propose a PaymentIntent,
   §6 gate evaluates, audit chain captures everything.

## Suggested Branch + Commit Structure

Topic branch: `feature/api-boot-binary` off `main`.

Commits, each independently reviewable:

1. `refactor: export register*Routes alongside buildXApp` (the
   six mechanical refactors, one commit)
2. `feat(api): config schema + zod loader`
3. `feat(api): IRawEvidenceService adapter wrapping @brain/raw`
4. `feat(api): OnchainScopeChecker via ethers + 60-s cache`
5. `feat(api): main.ts boot binary + bin entry + dev/start scripts`
6. `feat(infra): Dockerfile + healthcheck`
7. `chore: smoke-test playbook in docs/boot-binary-spec.md` (or
   delete this spec once the binary is real)

Total: 7 commits, ~600 LOC, one PR.
