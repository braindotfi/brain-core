# Brain

Financial intelligence protocol. Six layers, one API.

Brain turns financial activity into evidence, evidence into normalized
financial truth, truth into memory, memory into intelligence, and
intelligence into governed action. It does not hold funds. It does not
move money directly. It sits between an account holder and their financial
world as the structured intelligence layer.

## The six layers

| #   | Layer  | Owns                                           | Workspace            |
| --- | ------ | ---------------------------------------------- | -------------------- |
| 1   | Raw    | Source evidence (immutable)                    | `services/raw`       |
| 2   | Ledger | Machine-readable financial truth (11 entities) | `services/ledger`    |
| 3   | Wiki   | Human-readable financial memory + Q&A          | `services/wiki`      |
| 4   | Policy | Deterministic permission and approval logic    | `services/policy`    |
| 5   | Agent  | Proposal / PaymentIntent / MCP orchestration   | `services/execution` |
| 6   | Audit  | Immutable proof of what happened and why       | `services/audit`     |

The data flow is one-way upward except for two controlled write paths:
(a) human annotations and agent contributions write into Raw, never
directly into Ledger; (b) the Agent layer creates PaymentIntent rows
in the Ledger (the only ledger-write path that doesn't originate from
a Raw extraction). Every write at every layer emits an Audit event.

### External agents — the MCP surface

External AI agents connect to Brain via the Model Context Protocol
(MCP) at `POST /v1/agents/mcp`. The surface is JSON-RPC 2.0 over
single-shot HTTP and exposes 10 tools (5 ledger reads, 2 wiki reads,
1 raw contribute, 1 payment-intent propose, 1 agent action propose),
5 resource templates, and 5 canned prompts. Tools enforce per-call
scopes; the same `LedgerService` / `WikiService` /
`PaymentIntentService` methods the HTTP API uses are reused so policy
gating + audit emission are identical between the HTTP and MCP paths.

Authorization is anchored on-chain: every authorized third-party agent
has a registration entry in `BrainMCPAgentRegistry` with a scope
attestation. Brain's MCP server verifies that the agent's JWT
`scope_hash` claim matches the on-chain hash before any tool call.

There is no `payment_intent.execute` on the MCP surface. External
agents may _propose_ but never _execute_ — the §6 13-step
pre-execution gate stays the only execution path, behind human
approval where the policy demands it.

See `docs/mcp-architecture.md` for the design and `services/mcp/` for
the implementation.

## Companion docs

- `Brain_MVP_Architecture.md` — v0.3 blueprint (six-layer + MCP)
- `Brain_API_Specification.yaml` — v0.3 public HTTP + MCP contract
- `Brain_Engineering_Standards.md` v0.2.0 — conventions enforced in
  CI, including the §6 deterministic pre-execution gate that every
  financial action must pass
- `docs/mcp-architecture.md` — MCP surface design (Layer 5)
- `docs/v0.3-deliverables.md` — post-implementation report for the
  v0.3 refactor + hotfix + MCP feature

## Repository layout

```
brain/
├── services/
│   ├── api/              # TypeScript. Public HTTP API gateway. Hosts shared primitives.
│   ├── raw/              # TypeScript. Ingestion workers (Layer 1).
│   ├── ledger/           # TypeScript. Normalized financial truth (Layer 2).
│   ├── wiki/             # TypeScript. Memory pages, search, Q&A (Layer 3).
│   ├── policy/           # TypeScript. Rule VM and evaluator (Layer 4).
│   ├── execution/        # TypeScript. Agent layer — Proposals, PaymentIntents, §6 gate (Layer 5).
│   ├── mcp/              # TypeScript. MCP server — JSON-RPC, 10 tools, 5 resources, 5 prompts (Layer 5).
│   ├── audit/            # TypeScript. Append-only log + Merkle anchor publisher (Layer 6).
│   └── agents/           # Python. Extractors, reasoners, the three MVP agents.
├── contracts/            # Solidity + Foundry. The four smart contracts.
├── infra/                # Terraform. Azure resource definitions.
├── schemas/              # JSON Schemas per Ledger entity, per Wiki page type.
├── clients/              # Generated typed clients for each service.
├── tests/
│   ├── unit/             # Co-located with source in each workspace.
│   ├── integration/      # Cross-service. Run against real deps in containers.
│   ├── invariants/       # Static cross-layer invariant suite (15 invariants).
│   └── e2e/              # Full-stack against staging environment.
└── tools/                # Dev scripts, migration runners, backfill utilities.
```

`services/execution/` is the Agent-layer (Layer 5) workspace. The
directory name is retained from v0.2 for back-compat with the
`/execution/*` legacy routes; the package re-exports the v0.3
PaymentIntentService + ApprovalService alongside the legacy
ProposalService. New v0.3 routes live under `/agents/*`,
`/payment-intents/*`, and `/agents/mcp`.

`services/mcp/` is a sibling workspace (`@brain/mcp`) that hosts the
MCP server. It depends on `@brain/execution` for
`PaymentIntentService` but is wired onto the Fastify app via an
optional `registerMcp` callback so that `services/execution` doesn't
need to know about `@brain/mcp` (no workspace cycle).

## Prerequisites

- **Node 22 LTS** (use `nvm use` — `.nvmrc` pins the version)
- **pnpm 9+** (`corepack enable` or `npm install -g pnpm`)
- **Python 3.12** via [`uv`](https://docs.astral.sh/uv/)
- **Docker Desktop** or equivalent (Compose v2)
- **Foundry** (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)
- **Terraform 1.9+** (only needed when touching `infra/`)

## First-time setup

```bash
# 1. TypeScript workspaces
corepack enable
pnpm install

# 2. Python agents
cd services/agents && uv sync --extra dev && cd ../..

# 3. Smart contract dependencies
cd contracts && forge install && cd ..

# 4. Install pre-commit hook (secret scanner, §11.3)
./scripts/install-hooks.sh

# 5. Start local stack (Postgres + pgvector, Redis, LocalStack)
./scripts/dev-up.sh
```

## Common commands

### TypeScript

```bash
pnpm run lint          # eslint + prettier across all services
pnpm run typecheck     # tsc -b across all services
pnpm run test          # vitest, 80% coverage gate (§7.1)
pnpm run build         # emit dist/ for each service
```

### Python

```bash
pnpm run agents:lint       # ruff + black --check
pnpm run agents:typecheck  # mypy --strict
pnpm run agents:test       # pytest, 80% coverage gate
```

### Smart contracts

```bash
pnpm run contracts:build   # forge build
pnpm run contracts:test    # forge test
```

### Local stack

```bash
pnpm run dev:up        # docker compose up -d + wait for healthy
pnpm run dev:down      # docker compose down
```

Service URLs once the stack is healthy:

| Service    | URL                                                |
| ---------- | -------------------------------------------------- |
| Postgres   | `postgres://brain:brain@localhost:5432/brain`      |
| Redis      | `redis://localhost:6379`                           |
| LocalStack | `http://localhost:4566` (Azure Blob-equivalent S3) |

## Engineering standards

This repository follows `Brain_Engineering_Standards.md` v0.2.0 without
exception. Highlights enforced in CI:

- **Provenance on everything** — every derived Ledger row and Wiki page carries provenance, confidence, source evidence.
- **Tenant isolation at storage** — row-level security on every Postgres table; per-tenant Blob prefixes.
- **Idempotency by default** on writes.
- **Audit everything that matters** — append-only, Merkle-chained, on-chain anchored.
- **Deterministic pre-execution gate** (v0.2 §6) — no payment can execute without passing the 13-step gate, with audit events emitted both before and after.
- **80% unit-test coverage** per workspace.
- **No secrets in code.** Pre-commit hook + gitleaks in CI + Key Vault in production.
- **PR review required** for every change. AI-assisted PRs are labeled `ai-assisted` (§13.4).

## Build stages

The MVP ships in 10 build stages (0–9) plus a v0.3 architecture-refactor
phase set (`refactor-1` through `refactor-6`) that introduces the
Normalized Ledger layer and the §6 pre-execution gate, followed by
focused feature branches for documentation reconciliation
(`hotfix-1`) and the MCP server (`feature/mcp-server`). Each stage
and each phase is plan-first, human-approved, then a series of small
reviewed commits.

| Stage / branch     | Deliverable                                                           |
| ------------------ | --------------------------------------------------------------------- |
| 0                  | Repository scaffolding                                                |
| 1                  | Shared primitives (errors, auth, idempotency, observability)          |
| 2                  | Raw layer — 5 endpoints + 5 source adapters                           |
| 3                  | Wiki layer (v0.1 shape)                                               |
| 4                  | Policy layer — 6 endpoints, rule VM, EIP-712 signing                  |
| 5                  | 4 smart contracts on Base                                             |
| 6                  | Execution layer (v0.1 shape)                                          |
| 7                  | Audit layer — 5 endpoints, Merkle anchor publisher                    |
| 8                  | Terraform infrastructure + CI/CD pipelines                            |
| 9                  | End-to-end proof test suites                                          |
| refactor-1         | Six-layer doc realignment                                             |
| refactor-2         | Ledger scaffolding (workspace + 11 migrations + read-only API)        |
| refactor-3         | Migrate financial truth from Wiki → Ledger; rewrite Plaid extractor   |
| refactor-4         | PaymentIntent + §6 13-step pre-execution gate                         |
| refactor-5         | Reconciliation engine + Wiki page generation from Ledger              |
| refactor-6         | Invariant tests + golden-path dataset                                 |
| hotfix-1           | `/audit/entity/:type/:id` route + doc-claim reconciliation            |
| feature/mcp-server | `@brain/mcp` workspace — MCP server, 10 tools, 5 resources, 5 prompts |

Progress is tracked via PRs labeled `stage-N`, `refactor-N`, or the
feature/hotfix branch name.

## Support

- API docs: `Brain_API_Specification.yaml` (browsable via Swagger UI
  or Redoc) — includes the `/agents/mcp` JSON-RPC surface and the
  `McpErrorCode` schema
- MCP architecture: `docs/mcp-architecture.md`
- Error code registry: `services/api/src/shared/errors.ts`
- v0.3 deliverables report: `docs/v0.3-deliverables.md`
- Runbooks: `docs/` (populated from stage-8 onward)
