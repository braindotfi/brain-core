# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Source-of-truth documents

Read the relevant document before implementing or modifying anything in its domain:

- **`Brain_API_Specification.yaml`** — OpenAPI 3.1 contract for every HTTP endpoint and the MCP surface. Check this before touching any route.
- **`Brain_Engineering_Standards.md`** — v0.2.0, CI-enforced conventions: auth, errors, idempotency, observability, testing, deployment, secrets, code style. This overrides "what feels natural."
- **`Brain_MVP_Architecture.md`** — v0.3 protocol blueprint and the "why" behind the six-layer model.

## Rules for AI assistants (from Standards §14)

1. When intuition disagrees with the spec or standards, **follow the spec**. Your priors about how APIs usually look are not authoritative here.
2. When something is underspecified, **stop and ask**. Leave a clearly-marked `TODO` and surface for human review — do not guess.
3. When existing code violates a layer boundary (e.g., Policy reads Wiki, Agent mutates Ledger directly), **surface it. Do not reproduce the violation in new code.** Boundaries are non-negotiable.

PRs produced with AI assistance must be labeled `ai-assisted` (§13.4).

## Architecture — six layers

> The parent workspace CLAUDE.md says "five-layer" — that is stale. The codebase is **six layers** as of v0.3.

| #   | Layer  | Workspace                                 | Owns                                                 |
| --- | ------ | ----------------------------------------- | ---------------------------------------------------- |
| 1   | Raw    | `services/raw` (`@brain/raw`)             | Source evidence — immutable ingested payloads        |
| 2   | Ledger | `services/ledger` (`@brain/ledger`)       | Machine-readable financial truth (11 typed entities) |
| 3   | Wiki   | `services/wiki` (`@brain/wiki`)           | Human-readable memory + narrative Q&A (pgvector)     |
| 4   | Policy | `services/policy` (`@brain/policy`)       | Deterministic rule VM, EIP-712 signing (viem)        |
| 5   | Agent  | `services/execution` (`@brain/execution`) | PaymentIntent, ApprovalService, orchestration        |
| 5′  | MCP    | `services/mcp` (`@brain/mcp`)             | JSON-RPC 2.0 server — external agent surface         |
| 6   | Audit  | `services/audit` (`@brain/audit`)         | Append-only Merkle-chained log + on-chain anchor     |

Python agents (Plaid extractors, reasoners, three MVP agents) live in `services/agents/` (Python 3.12, uv-managed) — outside the TS workspace.

### Data-flow rules

- Writes flow upward only. Two controlled exceptions: (a) human/agent contributions write into Raw; (b) the Agent layer creates PaymentIntent rows in Ledger.
- Every write at every layer emits an audit event.
- **Policy and Execution never read Wiki.** Wiki is for narrative recall only; all machine-checkable preconditions come from Ledger.
- Agents never mutate Raw/Ledger/Policy/Audit directly — always go through the owning service's API.
- Every service owns its own DB schema. **Cross-service reads go through the owning service's API, never direct DB queries.**

## The §6 deterministic pre-execution gate

Lives in `services/api/src/shared/gate/`. Called by `POST /payment-intents/{id}/execute`, `POST /agents/{id}/actions` (money-movement actions), and the payment-agent worker.

The gate runs 13 sequential checks (identity, scope, policy DSL, source account, counterparty, sanctions, amount limit, balance, evidence, approval determination, approval grant, `policy_decision_id` creation, then audit before + after execution). It must not: read Wiki, defer to LLM judgment, mutate Ledger, or catch-and-continue on check failure. CI grep enforces no bypass path. Both the before and after audit events are mandatory and non-skippable.

## Commands

### TypeScript (root, pnpm workspace)

```bash
corepack enable && pnpm install   # first-time setup

pnpm run dev:up                   # start pg+pgvector :5432, redis :6379, localstack :4566
pnpm run dev:down

pnpm run lint                     # eslint + prettier --check
pnpm run lint:fix
pnpm run typecheck                # tsc -b across all TS services
pnpm run test                     # vitest run per service
pnpm run test:coverage            # 80/80/75/80 gate (lines/functions/statements/branches)
pnpm run build
```

Per-workspace:

```bash
pnpm -C services/<name> run typecheck
pnpm -C services/<name> run test
pnpm -C services/<name> run test:watch
pnpm -C services/<name> run test:integration   # where present
pnpm -C services/<name> exec vitest run src/foo.test.ts
pnpm -C services/<name> exec vitest run -t "pattern"
```

### Python (`services/agents/`, uv + Python 3.12)

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

### Tooling binaries

```bash
node tools/migrate/dist/cli.js up   # discover & apply services/*/migrations/*.sql
pnpm run seed                        # seed golden-path demo dataset
```

## Toolchain prerequisites & first-time setup

- Node 22 LTS (`nvm use`), pnpm ≥9 (`corepack enable`), Python 3.12 via `uv`, Docker Compose v2, Foundry (`foundryup`), Terraform 1.9+.

First-time setup order:

1. `corepack enable && pnpm install`
2. `cd services/agents && uv sync --extra dev && cd ../..`
3. `cd contracts && forge install && cd ..`
4. `./scripts/install-hooks.sh` — installs secret-scanner pre-commit hook (mandatory)
5. `./scripts/dev-up.sh` — starts infrastructure containers, waits for healthy

## Code conventions (CI-enforced)

**TypeScript** — strict-maximal: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `isolatedModules`, NodeNext module resolution.

ESLint hard errors:

- `no-explicit-any` — **no `any` anywhere**
- `@ts-ignore`/`@ts-expect-error` requires a comment ≥10 chars
- `consistent-type-imports`
- `no-console: warn` — only `console.warn`/`console.error` are permitted
- `eqeqeq: always`

Prettier: double quotes, semicolons, trailing commas everywhere, 100-col width, LF line endings.

**Python** — `ruff`, `black`, `mypy --strict`; type hints on every public function.

**Solidity** — NatSpec on every function, an event on every state change, no upgradable contracts in MVP.

**Commits** — imperative mood, present tense, ≤72 char subject.

## Repository layout

```
services/
  api/            @brain/api — HTTP gateway + all shared primitives (auth, errors, gate, …)
  raw/            @brain/raw — Layer 1 ingestion workers
  ledger/         @brain/ledger — Layer 2 (11 entities + typed JSON schemas)
  wiki/           @brain/wiki — Layer 3 memory + pgvector
  policy/         @brain/policy — Layer 4 rule VM + EIP-712 signing
  execution/      @brain/execution — Layer 5 (also retains v0.2 legacy /execution/* routes)
  mcp/            @brain/mcp — Layer 5′ JSON-RPC MCP server
  audit/          @brain/audit — Layer 6 Merkle log + on-chain anchor publisher
  agents/         Python agents (excluded from all TS commands and ESLint)
contracts/src/    BrainAuditAnchor, BrainPolicyRegistry, BrainSmartAccount, BrainMCPAgentRegistry
infra/            Terraform — Azure
schemas/entity/   JSON Schemas per ledger entity (account, agent, counterparty, …)
clients/          Generated typed clients (from OpenAPI)
tests/
  e2e/            @brain/e2e — Series A proof-points against staging
  invariants/     @brain/invariants — 15 cross-layer invariants
tools/
  migrate/        brain-migrate bin — forward-compatible SQL migrations
  seed-golden-path/  brain-seed-golden-path bin — 2-bank/1-card/5-sub demo dataset
scripts/          dev-up.sh, install-hooks.sh, pre-commit.sh
docs/             mcp-architecture.md, v0.3-deliverables.md, boot-binary-spec.md, rollback.md
```

Shared primitives all live in `services/api/src/shared/` — auth, errors, gate, idempotency, audit, db, blob, queue, http, llm, logger, metrics, tracing, webhooks, hashing, ids, contracts, config.

New v0.3 routes live under `/agents/*`, `/payment-intents/*`, `/agents/mcp`. The `services/execution/` dir retains v0.2 `/execution/*` routes for back-compat.

## MCP server (`@brain/mcp`)

- Mount: `POST /v1/agents/mcp` — JSON-RPC 2.0, single-shot HTTP, no SSE/streaming, no session state (v0.3).
- Surface: 10 tools (ledger reads ×5, wiki reads ×2, `raw.contribute` ×1, propose-only payment/agent actions ×2), 6 resource URIs (`brain://…`), 5 prompts.
- **No `payment_intent.execute` tool — ever.** Execution is Brain-internal behind the §6 gate.
- Auth chain: Fastify JWT plugin → agent record `active` → JWT `scope_hash` matches on-chain `BrainMCPAgentRegistry` (60s cache, Base RPC fallback) → tool scope → tenant equality.
- Every successful tool/resource call emits `agent.mcp.tool_called`; mutating tools also emit the same inner audit events as the HTTP API.
- Wired into the execution Fastify app via an optional `registerMcp` callback — `services/execution` does not depend on `@brain/mcp` (no workspace cycle).

## Per-layer "must not" rules

- **Raw**: never mutate ingested payloads (tombstone only); never store financial conclusions as authoritative facts.
- **Ledger**: rows must validate against `schemas/entity/` JSON Schemas; agent-contributed rows capped at `confidence: 0.5`.
- **Wiki**: never the source of truth for balances, obligations, transactions, or permissions; never read by Policy or Execution.
- **Policy**: never executes or mutates Ledger/Audit; writes exactly one `policy_decisions` row per evaluation.
- **Agent**: never mutates Raw/Ledger/Policy/Audit directly; all writes via the owning service's API.
- **Audit**: append-only, no UPDATE/DELETE; a published Merkle root cannot be re-published.

## Non-negotiable principles (Standards §1)

1. **Provenance on everything** — every derived Ledger row and Wiki page carries `provenance`, `confidence`, `source_ids`/`evidence_ids`. Missing these is a bug.
2. **Tenant isolation at the storage layer** — Postgres RLS on every table; per-tenant Azure Blob path prefixes. Shared-query-with-filter is not acceptable for tenant data.
3. **Idempotency by default** — every write endpoint is naturally idempotent or accepts `Idempotency-Key`; webhook handlers idempotent by provider event id; 24h Redis TTL.
4. **Audit everything that matters** — append-only, Merkle-chained, on-chain anchored. If it is not in the log, it did not happen.
5. **Deterministic pre-execution gate** — no financial execution may bypass §6; Policy reads Ledger not Wiki; LLM judgment never replaces a deterministic precondition.

## Auth & errors

- Bearer JWT on every endpoint except `/raw/webhooks/{provider}` (HMAC), `/audit/verify` (pure function), root health.
- 15-min access tokens, rotating refresh tokens. Scopes: `{layer}:{verb}`.
- External agents register on-chain in `BrainMCPAgentRegistry` with an EIP-712 scope attestation.
- Error envelope: `{ error: { code, message, details, request_id, docs_url } }`. `code` format: `{domain}_{condition}` — stable forever once shipped. **Never return HTTP 200 with an error in the body.** Registry: `services/api/src/shared/errors.ts`.

## Testing

- Unit: vitest, 80% coverage gate per workspace.
- Integration: every OpenAPI endpoint needs happy-path + error-path tests (`test:integration` configs per service where present).
- Property tests with `fast-check` for: policy evaluator, Merkle anchor builder, reconciliation matcher, §6 gate, and four Foundry contract invariants.
- E2E: three Series A proof-points against staging (`tests/e2e/`).
- 15 cross-layer invariants enforced in `tests/invariants/` — e.g., "no payment executes from Wiki data alone", "every PaymentIntent has a `policy_decision_id` before execution".

## Secrets & security

Run `./scripts/install-hooks.sh` once — it installs a pre-commit hook that scans for AWS/GitHub/PEM/Slack/Anthropic/OpenAI/Azure/JWT credential patterns. `gitleaks` runs in CI. A leaked secret triggers immediate rotation and a security incident. Production secrets live only in Azure Key Vault via managed identity.

## Known in-progress work

- **Stubs**: 5 reconciliation matchers are stubbed — see `docs/v0.3-deliverables.md` for the complete list.
- **Python agents**: `services/agents/` is scaffolded but the Plaid extractor, reconciliation agent, payment agent, and anomaly agent are not yet implemented.
- **Outbound webhook retries**: `WebhookAuditEmitter` dispatches fire-and-forget (no retry queue). A BullMQ `brain.audit.webhookDispatch` worker is the planned follow-up.
- **`@brain/sdk`**: no npm SDK package yet — quickstart consumers use the raw HTTP API or the generated OpenAPI client in `clients/`.

## When in doubt

Re-read §14 of `Brain_Engineering_Standards.md`. Surface the question — don't guess.
