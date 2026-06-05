# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Source-of-Truth Documents

Read the relevant document before implementing or modifying anything in its domain:

- **`Brain_API_Specification.yaml`**: OpenAPI 3.1 contract for every HTTP endpoint and the MCP surface. Check this before touching any route.
- **`Brain_Engineering_Standards.md`**: v0.2.0, CI-enforced conventions: auth, errors, idempotency, observability, testing, deployment, secrets, code style. This overrides "what feels natural."
- **`Brain_MVP_Architecture.md`**: v0.4 protocol blueprint and the "why" behind the six-layer model.

## Rules for AI Assistants (from Standards §14)

1. When intuition disagrees with the spec or standards, **follow the spec**. Your priors about how APIs usually look are not authoritative here.
2. When something is underspecified, **stop and ask**. Leave a clearly-marked `TODO` and surface for human review, do not guess.
3. When existing code violates a layer boundary (e.g., Policy reads Wiki, Agent mutates Ledger directly), **surface it. Do not reproduce the violation in new code.** Boundaries are non-negotiable.

PRs produced with AI assistance must be labeled `ai-assisted` (§13.4).

## Architecture, Six Layers

> The parent workspace CLAUDE.md says "five-layer", that is stale. The codebase is **six layers** as of v0.3.

| #   | Layer  | Workspace                                 | Owns                                                 |
| --- | ------ | ----------------------------------------- | ---------------------------------------------------- |
| 1   | Raw    | `services/raw` (`@brain/raw`)             | Source evidence, immutable ingested payloads         |
| 2   | Ledger | `services/ledger` (`@brain/ledger`)       | Machine-readable financial truth (11 typed entities) |
| 3   | Wiki   | `services/wiki` (`@brain/wiki`)           | Human-readable memory + narrative Q&A (pgvector)     |
| 4   | Policy | `services/policy` (`@brain/policy`)       | Deterministic rule VM, EIP-712 signing (viem)        |
| 5   | Agent  | `services/execution` (`@brain/execution`) | PaymentIntent, ApprovalService, orchestration        |
| 5′  | MCP    | `services/mcp` (`@brain/mcp`)             | JSON-RPC 2.0 server, external agent surface          |
| 6   | Audit  | `services/audit` (`@brain/audit`)         | Append-only Merkle-chained log + on-chain anchor     |

Workspace `services/execution` implements layer 5 (Agent). The directory rename is deferred; the layer name in docs is "Agent".

Python agents (Plaid extractors, reasoners, three MVP agents, plus the RFC 0004 `document_extractor`) live in `services/agents/` (Python 3.12, uv-managed), outside the TS workspace.

Two TypeScript agent-infrastructure services sit alongside the layers (not in the table above): `services/agent-router` (`@brain/agent-router`, routes domain events/intents to internal agents via `POST /agents/route`) and `services/internal-agents` (`@brain/internal-agents`, the first-party agent catalog. Capability definitions + handlers).

### Data-Flow Rules

- Writes flow upward only. Two controlled exceptions: (a) human/agent contributions write into Raw; (b) the Agent layer creates PaymentIntent rows in Ledger.
- Every write at every layer emits an audit event.
- **Policy and Execution never read Wiki.** Wiki is for narrative recall only; all machine-checkable preconditions come from Ledger.
- Agents never mutate Raw/Ledger/Policy/Audit directly, always go through the owning service's API.
- Every service owns its own DB schema. **Cross-service reads go through the owning service's API, never direct DB queries**. With sanctioned exceptions: the Wiki layer is a read-projection of Ledger and reads Ledger tables read-only (via a `TenantScopedClient`) to generate pages and answer questions, never writing Ledger or reading Wiki text in those paths (enforced by the §8.4 invariants); plus system/admin cross-tenant jobs (e.g. audit anchoring) and demo-mode sandbox resolvers. All cross-service **writes** still go through the owning service's API.

## The §6 Deterministic Pre-Execution Gate

Lives in `shared/src/gate/` (the top-level `@brain/shared` package). Called by `POST /payment-intents/{id}/execute` and `POST /actions/{id}/execute` (both via `PaymentIntentService.execute`).

The gate runs **13 numbered checks plus 9 hardening additions** (`1.5`, `3.5`, `5.5`, `6.5`, `6.6`, `7.5`, `8.5`, `9.5`, `11.5`), 22 entries total (identity, agent behavior pinned, scope, policy DSL, on-chain settlement permitted, source account, counterparty, agent counterparty attested, sanctions, x402 payment context, escrow state bound, amount limit, ledger-state binding, balance, micropayment cap within window, evidence present, evidence-semantic validation, approval determination, approval grant, duplicate-payment protection, `policy_decision_id` creation, then audit before + after execution. All persisted into the `gate_checks` snapshot). The additions are additive: several record `not_applicable` when their loader is unwired (notably the M2M/x402/escrow set 3.5/5.5/6.5/6.6/8.5. See "Known in-Progress Work" below), so the canonical happy path is the 13 numbered checks (see Engineering Standards §6.2 / §6.2.1). It must not: read Wiki, defer to LLM judgment, mutate Ledger, or catch-and-continue on check failure. Both the before and after audit events are mandatory and non-skippable. `scripts/check-gate-bypass.mjs` (wired into `pnpm run lint`) enforces no bypass path: no rail dispatch or transition to `executed` may occur outside `PaymentIntentService`. The gate emits per-check + outcome + duration metrics through the shared `MetricsEmitter` (`brain.gate.check.count` / `brain.gate.outcome.count` / `brain.gate.duration_ms`; Grafana scaffold at `infra/grafana/gate.json`).

## Commands

### TypeScript (Root, Pnpm Workspace)

```bash
corepack enable && pnpm install   # first-time setup

pnpm run dev:up                   # start pg+pgvector :5432, redis :6379, localstack :4566
pnpm run dev:down

pnpm run lint                     # eslint + prettier --check + 8 CI guard scripts (see below)
pnpm run lint:fix
pnpm run lint:openapi             # Redocly lint of Brain_API_Specification.yaml (also in lint)
pnpm run typecheck                # tsc -b across all TS services
pnpm run test                     # vitest run per service + test:scripts
pnpm run test:coverage            # 80/80/75/80 gate (lines/functions/statements/branches)
pnpm run test:scripts             # node --test scripts/__tests__/*.test.mjs
pnpm run build

pnpm run demo:golden-path         # run the full golden-path demo flow
pnpm run demo:reset               # reset demo state (alias for tools/demo-reset)
pnpm run plaid:sandbox            # start the Plaid sandbox tool
```

`pnpm run lint` bundles 11 individually runnable CI guard scripts. Each can be called standalone:

```bash
pnpm run check-scope-vocab
pnpm run check-gate-bypass
pnpm run check-payment-intent-loaders
pnpm run check-no-em-dashes
pnpm run check-wiki-no-ledger-write
pnpm run check-policy-no-wiki-read
pnpm run check-no-onchain-pii
pnpm run check-docs-drift
pnpm run check-rails-catalog-drift
pnpm run check-escrow-audit-marker
pnpm run check-risk-register-drift
```

> `check-promotion-readiness` also exists (`scripts/check-promotion-readiness.mjs`) but is **not**
> wired into `lint`. Run it manually before promoting a branch.

`pnpm run production-readiness` is a separate aggregator. Given the
current env, would the boot fences pass? Reports per-rail readiness,
per-fence status, CI-guard wiring, and deferred items. Reads
`docs/risk-register.json` and turns any open + P0 risk into a red row.
Add `--json` for machine-readable output (CI / dashboards). Exit 1 on
any red. The PR CI workflow uploads the `--json` output as a per-commit
build artifact (`production-readiness-${sha}`, 90-day retention).

`pnpm run readiness-snapshot <tag>` captures a per-tag snapshot of the
aggregator JSON to `docs/readiness-history/<tag>.json` (used at release
tag push). `pnpm run readiness-trend` reads every snapshot and prints
a per-release trend table (overall status, red/yellow/green counts,
open P0/P1 risks, ΔP0 vs prior snapshot) for investor updates and
release-readiness reviews.

Per-workspace:

```bash
pnpm -C services/<name> run typecheck
pnpm -C services/<name> run test
pnpm -C services/<name> run test:watch
pnpm -C services/<name> run test:integration   # where present
pnpm -C services/<name> run clean              # rm -rf dist *.tsbuildinfo (every workspace)
pnpm -C services/<name> exec vitest run src/foo.test.ts
pnpm -C services/<name> exec vitest run -t "pattern"

# API gateway dev server
pnpm -C services/api run dev    # tsx watch src/main.ts
pnpm -C services/api run start  # node dist/main.js (production build)

# SDK regen (clients/sdk/ is generated from Brain_API_Specification.yaml)
pnpm -C clients/sdk run codegen        # regenerate from OpenAPI spec
pnpm -C clients/sdk run codegen:check  # verify generated files are up-to-date
```

### Python (`services/agents/`, Uv + Python 3.12)

```bash
pnpm run agents:lint        # ruff check + black --check
pnpm run agents:typecheck   # mypy --strict
pnpm run agents:test        # pytest, 80% coverage gate
```

### Contracts (`contracts/`, Foundry, Solidity ≥0.8.24)

```bash
pnpm run contracts:build    # forge build
pnpm run contracts:test     # forge test
```

### Tooling Binaries

```bash
pnpm run build                              # build tools first (produces the dist/ below)
node tools/migrate/dist/cli.js up           # discover & apply services/*/migrations/*.sql
pnpm -C tools/seed-golden-path run seed     # seed golden-path demo dataset
pnpm -C tools/demo-reset run reset          # wipe and re-seed demo state
pnpm -C tools/dev-token run start           # mint a short-lived dev JWT for local testing
pnpm -C tools/plaid-sandbox run start       # drive Plaid sandbox flows (fire webhooks, etc.)
```

## Toolchain Prerequisites & First-Time Setup

- Node 22 LTS (`nvm use`), pnpm ≥10 (`corepack enable`), Python 3.12 via `uv`, Docker Compose v2, Foundry (`foundryup`), Terraform 1.9+.

First-time setup order:

1. `corepack enable && pnpm install`
2. `cd services/agents && uv sync --extra dev && cd ../..`
3. `git submodule update --init --recursive` (pulls `contracts/lib/forge-std` pinned to v1.16.1; not needed if you cloned with `--recursive`)
4. `./scripts/install-hooks.sh`, installs secret-scanner pre-commit hook (mandatory)
5. `./scripts/dev-up.sh`, starts infrastructure containers, waits for healthy

## Code Conventions (CI-Enforced)

**TypeScript**: strict-maximal: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `isolatedModules`, NodeNext module resolution.

ESLint hard errors:

- `no-explicit-any`, **no `any` anywhere**
- `@ts-ignore`/`@ts-expect-error` requires a comment ≥10 chars
- `consistent-type-imports`
- `no-console: warn`, only `console.warn`/`console.error` are permitted
- `eqeqeq: always`

Prettier: double quotes, semicolons, trailing commas everywhere, 100-col width, LF line endings.

**Python**: `ruff`, `black`, `mypy --strict`; type hints on every public function.

**Solidity**: NatSpec on every function, an event on every state change, no upgradable contracts in MVP.

**Commits**: imperative mood, present tense, ≤72 char subject.

## Repository Layout

```
services/
  api/            @brain/api, HTTP gateway (auth/webhook/MCP wiring + boot)
  raw/            @brain/raw, Layer 1 ingestion workers
  ledger/         @brain/ledger, Layer 2 (11 entities + typed JSON schemas)
  wiki/           @brain/wiki, Layer 3 memory + pgvector
  policy/         @brain/policy, Layer 4 rule VM + EIP-712 signing
  execution/      @brain/execution, Layer 5 (also retains v0.2 legacy /execution/* routes)
  mcp/            @brain/mcp, Layer 5′ JSON-RPC MCP server
  audit/          @brain/audit, Layer 6 Merkle log + on-chain anchor publisher
  agent-router/   @brain/agent-router, event/intent → internal-agent routing (POST /agents/route)
  internal-agents/ @brain/internal-agents, first-party agent catalog (definitions + handlers)
  agents/         Python agents (excluded from all TS commands and ESLint)
shared/           @brain/shared, all cross-cutting primitives (auth, errors, gate, db, …)
contracts/src/    BrainAuditAnchor, BrainPolicyRegistry, BrainSmartAccount, BrainMCPAgentRegistry, BrainEscrow (+ IBrainEscrow), BrainReputationRegistry (+ IBrainReputationRegistry)
infra/            Terraform, Azure
schemas/entity/   JSON Schemas for 6 of the 11 ledger entities (account, agent, counterparty, obligation, policy, transaction)
clients/          Generated typed clients (from OpenAPI)
tests/
  e2e/            @brain/e2e, Series A proof-points against staging
  invariants/     @brain/invariants, 15 cross-layer invariants
  adversarial/    @brain/adversarial, security/adversarial property tests
tools/
  migrate/        brain-migrate bin, forward-compatible SQL migrations
  seed-golden-path/  brain-seed-golden-path bin, 2-bank/1-card/5-sub demo dataset
  demo-reset/     brain-demo-reset bin, wipe + re-seed demo state
  dev-token/      dev JWT minter for local testing
  plaid-sandbox/  Plaid sandbox driver (fire webhooks, simulate transfers)
  postgres-init/  Postgres role/extension init scripts (no package.json)
scripts/          dev-up.sh, install-hooks.sh, pre-commit.sh, demo/golden-path.sh, check-*.mjs
docs/             Internal engineering docs (mcp-architecture.md, boot-binary-spec.md, rollback.md,
                  rails-matrix.md (release-manager rail support table),
                  plus audits, RFCs, scaling notes, v0.4 runbooks. List is illustrative.
                  Diligence-facing enterprise readiness page lives in the published
                  GitBook tree at `architecture/enterprise-readiness.md`)
```

Shared primitives all live in the top-level `shared/` package (`@brain/shared`): auth, errors, gate, idempotency, audit, db, blob, queue, http, llm, logger, metrics, tracing, webhooks, hashing, ids, contracts, config. (`services/api` is a thin gateway that consumes them, not their host.)

### Documentation-site tree (Markdown only, not runtime code)

The repo also contains a GitBook-style published docs tree. These directories are **Markdown
documentation only**. They hold no TypeScript/Python/Solidity source:

`protocol/`, `concepts/`, `build/`, `api-reference/`, `architecture/`, `introduction/`,
`legal/`, `resources/`

**Naming-collision hazard**. Two doc dirs share a name prefix with runtime source dirs:

| Directory          | What it actually is                     |
| ------------------ | --------------------------------------- |
| `smart-contracts/` | Markdown docs per contract              |
| `contracts/`       | Solidity source (`contracts/src/*.sol`) |
| `mcp-server/`      | Markdown docs for the MCP surface       |
| `services/mcp`     | The actual `@brain/mcp` runtime service |

New v0.3 routes live under `/agents/*`, `/payment-intents/*`, `/agents/mcp`. The `services/execution/` dir retains v0.2 `/execution/*` routes for back-compat.

## MCP Server (`@brain/mcp`)

- Mount: `POST /v1/agents/mcp`, JSON-RPC 2.0, single-shot HTTP, no SSE/streaming, no session state (v0.3).
- Surface: **12 tools** (ledger reads ×5, wiki reads ×2, `raw.contribute` ×1, propose/cancel/list payment actions ×3, agent action propose ×1), **7 resource URIs** (`brain://…`. Ledger accounts/transactions/obligations/payment-intents, wiki pages, `payments/action_types` catalog, `proofs/{action_id}`), 5 prompts. `payment_intent.propose` accepts the on-chain settlement action types `x402_settle` and `escrow_release` by name (with the required `pay_to` / `escrow_id` + `job_terms_hash` fields).
- **No `payment_intent.execute` tool, ever.** Execution is Brain-internal behind the §6 gate. `payment_intent.cancel` is the only state-mutating MCP tool besides `propose`; it is restricted to the proposing agent and to `proposed` / `pending_approval` states.
- Auth chain: Fastify JWT plugin → agent record `active` → JWT `scope_hash` matches on-chain `BrainMCPAgentRegistry` (60s cache, Base RPC fallback) → tool scope → tenant equality.
- Every successful tool/resource call emits `agent.mcp.tool_called`; mutating tools also emit the same inner audit events as the HTTP API.
- Wired into the execution Fastify app via an optional `registerMcp` callback, `services/execution` does not depend on `@brain/mcp` (no workspace cycle).

## Autonomy Modes (shadow / recommend / confirm / live)

`shared/src/agents/autonomy.ts` collapses three orthogonal axes (LIVE_AGENTS promotion, `default_authority`, policy outcome) into one observable label so the surface vocabulary lines up with the pitch deck. Use `deriveAutonomyMode({ isLive, defaultAuthority, policyMaxOutcome })`. Truth table (first matching row wins):

| isLive | defaultAuthority | policyMaxOutcome | → Autonomy mode |
| ------ | ---------------- | ---------------- | --------------- |
| false  | (any)            | (any)            | **shadow**      |
| true   | `notify_only`    | (any)            | **shadow**      |
| true   | `propose`        | (any)            | **recommend**   |
| true   | `execute`        | `reject`         | **shadow**      |
| true   | `execute`        | `confirm`        | **confirm**     |
| true   | `execute`        | `allow`          | **live**        |

`live` is the only mode that permits unattended execution. Every mode (including `live`) still passes the deterministic §6 gate. The four modes label _operator expectations_, not safety bypasses.

## Per-Layer "Must Not" Rules

- **Raw**: never mutate ingested payloads (tombstone only); never store financial conclusions as authoritative facts.
- **Ledger**: rows must validate against `schemas/entity/` JSON Schemas; agent-contributed rows capped at `confidence: 0.5`.
- **Wiki**: never the source of truth for balances, obligations, transactions, or permissions; never read by Policy or Execution.
- **Policy**: never executes or mutates Ledger/Audit; writes exactly one `policy_decisions` row per evaluation.
- **Agent**: never mutates Raw/Ledger/Policy/Audit directly; all writes via the owning service's API.
- **Audit**: append-only, no UPDATE/DELETE; a published Merkle root cannot be re-published.

## Non-Negotiable Principles (Standards §1)

1. **Provenance on everything**: every derived Ledger row and Wiki page carries `provenance`, `confidence`, `source_ids`/`evidence_ids`. Missing these is a bug.
2. **Tenant isolation at the storage layer**: Postgres RLS on every table; per-tenant Azure Blob path prefixes. Shared-query-with-filter is not acceptable for tenant data. Migrations _arm_ RLS (`ENABLE ROW LEVEL SECURITY`), but it is only _enforced_ under the role model in `infra/db-roles.sql`. A non-owner `brain_app` role plus `FORCE ROW LEVEL SECURITY` (Postgres skips RLS for a table owner otherwise); legitimate cross-tenant readers (normalize worker, Plaid webhook resolver, SIWX registry, audit emitter) use the `brain_privileged` BYPASSRLS role.
3. **Idempotency by default**: every write endpoint is naturally idempotent or accepts `Idempotency-Key`; webhook handlers idempotent by provider event id; 24h Redis TTL.
4. **Audit everything that matters**: append-only, Merkle-chained, on-chain anchored. If it is not in the log, it did not happen.
5. **Deterministic pre-execution gate**: no financial execution may bypass §6; Policy reads Ledger not Wiki; LLM judgment never replaces a deterministic precondition.

## Auth & Errors

- Bearer JWT on every endpoint except `/raw/webhooks/{provider}` (HMAC), `/audit/verify` (pure function), root health.
- 15-min access tokens, rotating refresh tokens. Scopes: `{layer}:{verb}`.
- External agents register on-chain in `BrainMCPAgentRegistry` with an EIP-712 scope attestation.
- Error envelope: `{ error: { code, message, details, request_id, docs_url } }`. `code` format: `{domain}_{condition}`, stable forever once shipped. **Never return HTTP 200 with an error in the body.** Registry: `shared/src/errors.ts` (`@brain/shared`).

## Testing

- Unit: vitest, 80% coverage gate per workspace.
- Integration: every OpenAPI endpoint needs happy-path + error-path tests (`test:integration` configs per service where present).
- Property tests with `fast-check` for: policy evaluator, Merkle anchor builder, reconciliation matcher, §6 gate, and four Foundry contract invariants.
- E2E: three Series A proof-points against staging (`tests/e2e/`).
- 15 cross-layer invariants enforced in `tests/invariants/`, e.g., "no payment executes from Wiki data alone", "every PaymentIntent has a `policy_decision_id` before execution".

## Secrets & Security

Run `./scripts/install-hooks.sh` once, it installs a pre-commit hook that scans for AWS/GitHub/PEM/Slack/Anthropic/OpenAI/Azure/JWT credential patterns. `gitleaks` runs in CI. A leaked secret triggers immediate rotation and a security incident. Production secrets live only in Azure Key Vault via managed identity.

## Known in-Progress Work

- **Payment rails. All four wired**: `bank_ach` (`AchPlaidRail` with a real Plaid Transfer client), `onchain_base` (`OnchainBaseRail` with viem + KMS-signed session key), `x402_base` (`X402BaseRail` with a real `X402Client` against the Coinbase facilitator), and `escrow_base` (`EscrowBaseRail` against `BrainEscrow.release`) all register in `RailRegistry` at boot when their env vars are configured (see `services/api/src/main.ts:902-1003`). The `*StubRail` classes in `rails/stubs.ts` are retained for dev/test + `erp_writeback`; they **fail closed under `NODE_ENV=production`** (`defaultRails()` and each dispatch throw rather than fake-settle). A boot fence (`services/api/src/composition/rails-prod-fence.ts`) additionally refuses to start the api in `NODE_ENV=production` when zero live rails would register, so orchestrators see CrashLoopBackoff instead of a quiet 100%-of-payments-failing wave. All six protocol contracts are deployed on Base Sepolia (addresses in `SECURITY.md`); **mainnet remains blocked on the external smart-contract audit.** A second boot fence (`services/api/src/composition/escrow-audit-gate.ts`) refuses to start the api when `BRAIN_BASE_CHAIN_ID === 8453` + `BRAIN_ESCROW_ADDRESS` is set + `BRAIN_ESCROW_AUDIT_APPROVED !== "true"`, so an operator must explicitly attest audit completion before mainnet escrow registration is possible.
- **Reconciliation matchers**: all 8 are concrete implementations (`services/ledger/src/reconciliation/{statement-balance,card-charge,invoice-payment,transaction-receipt,wallet-transfer,payroll-bank-debit,subscription-charge,onchain-settlement}.ts`), registered in `ReconciliationService`, and covered by unit + fast-check property tests (in the ledger coverage gate).
- **Python agents**: the four MVP agents (`reconciliation/`, `payment/`, `anomaly/`, `plaid_extractor/`) plus the RFC 0004 `document_extractor/` are implemented under `services/agents/brain_agents/`. Each owns a FastAPI router (`/run/<agent>`); they share `BrainApiClient` for `/v1/execution/propose`, `/v1/raw/ingest`, and `/v1/raw/{id}/parsed` calls. `plaid_extractor` is deterministic (no LLM); the others reason via OpenAI. `document_extractor` turns an uploaded document (CSV/text/XLSX via the deterministic `extract_text`; PDF deferred) into a `doc_obligation_v1` payload and writes it to Raw via `BrainApiClient.post_parsed` (it never touches the Ledger). mypy strict + pytest 80% coverage gates apply. **Inbound HMAC auth**: every `/run/*` route verifies `X-Brain-Auth: sha256=<hex>` over the request body via shared `BRAIN_AGENTS_INBOUND_SECRET`. The Python side fails at _boot_ in production when the secret is unset (`create_app()` raises `RuntimeError` before FastAPI is constructed); the api side signs every outbound `ReconciliationAgentClient` call with the same secret (`services/api/src/agents/sign-agent-request.ts`) and refuses to start when `RECONCILIATION_AGENT_URL` is set in production without `BRAIN_AGENTS_INBOUND_SECRET`.
- **Outbound webhook retries**: `WebhookAuditEmitter` still dispatches fire-and-forget for the first attempt; failures land in `webhook_dead_letters` (H-20). Retries are now drained automatically by `startWebhookDispatchWorker` (`services/audit/src/webhook-dispatch-worker.ts`) with exponential backoff (30s/60s/120s/240s/480s cap). On `MAX_WEBHOOK_DELIVERY_ATTEMPTS` it emits both the `brain.audit.webhook.dlq.count` metric and the `audit.webhook.delivery.exhausted` audit event so operators see the hard giveup.
- **`@brain/sdk`**: the typed client exists at `clients/sdk` (`@brain/sdk`, generated from the OpenAPI spec, version `0.1.0-rc.0`) but is not yet published to npm.
- **BrainSmartAccount session-key cap modes** (batch 8, closes peer-review findings F-3 + F-4): the `SessionKey` struct carries an explicit `capToken` field. When `address(0)` ("NATIVE" mode) caps apply to `msg.value` in wei. When non-zero ("ERC20" mode) caps are denominated in `capToken`'s raw units; `grantSessionKey` enforces that `allowedTargets == [capToken]` and `allowedSelectors ⊆ {transfer, approve, transferFrom}` so caps are always meterable. Closes the unit-blind-ERC20-cap and unmetered-non-decodable-selector findings. See `contracts/src/BrainSmartAccount.sol` + 7 new Foundry tests.
- **Window-spend reconciliation** (batch 8, closes peer-review F-10): the off-chain `services/policy/src/agent-window-spend.ts` loader now uses the same tumbling window formula (`floor(extract(epoch from now()) / windowSeconds) * windowSeconds`) as `BrainSmartAccount._windowSpent`, so the §6 gate's agent-budget check (8.5) and the on-chain session-key budget never disagree at period boundaries.
- **RFC 0004 source-agnostic ingestion + earned-autonomy** (`docs/rfcs/0004-source-agnostic-ingestion-to-autonomy.md`, stage 1+2). A document can be ingested without Plaid and flow to autonomy:
  - **Producer**: `POST /raw/{raw_id}/parsed` (Raw-owned, idempotent on `(artifact, parser, version)`) is the first writer of `raw_parsed`; the `document_extractor` agent calls it. Writing into Ledger stays the normalize service's job, so the layer boundary holds (extraction is a Raw contribution).
  - **Normalize**: `LedgerService.normalizeFromRaw` dispatches `doc_obligation_v1` to a deterministic extractor that resolves a counterparty + writes an obligation via `upsertObligationRow`, both `agent_contributed` (confidence capped ≤ 0.5).
  - **Q&A**: the Wiki question endpoint already grounds in obligations; the obligation excerpt now carries `cp=` so "what do I owe and to whom" resolves the vendor.
  - **Earned autonomy** (§5.2): intent confidence is threaded into `GatePaymentIntent` → `Action.confidence`, so a tenant policy rule `agent.confidence.gte` is a live gate. A new intent's confidence is capped at the obligation it pays (`resolveObligationConfidence`), and reconciliation corroboration raises an obligation's confidence upward-only (≤ 0.9, `agent_contributed → extracted`) in `persistMatch`. The §6 gate is unchanged and still reads Ledger, never Wiki; confidence is a policy lever, not a gate check.
  - **Review-hardening follow-ups**: `resolveObligationConfidence` is a **required** factory loader (wired at every `PaymentIntentService` mount), and a third boot fence (`services/api/src/composition/payment-loaders-prod-fence.ts`) refuses to start in `NODE_ENV=production` unless the always-applicable money-path loaders (`resolveEvidence` 9.5, `detectDuplicates` 11.5, `resolveObligationConfidence`) are wired. Separately, the v0.2 `/execution/*` routes are confirmed **live** (generic action propose/approve API used by the SDK `actions` resource + the Python agents, no v0.3 replacement) and were NOT deleted; only the genuinely-inert bits were cleaned up (dead `hasRole` removed; `/execution/mcp` is an honest deprecation pointer to `/v1/agents/mcp`).

## When in Doubt

Re-read §14 of `Brain_Engineering_Standards.md`. Surface the question, don't guess.
