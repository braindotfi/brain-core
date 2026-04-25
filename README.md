# Brain

Financial intelligence protocol. Six layers, one API.

Brain turns financial activity into evidence, evidence into normalized
financial truth, truth into memory, memory into intelligence, and
intelligence into governed action. It does not hold funds. It does not
move money directly. It sits between an account holder and their financial
world as the structured intelligence layer.

| Layer  | Owns                                          |
| ------ | --------------------------------------------- |
| Raw    | Source evidence                               |
| Ledger | Machine-readable financial truth              |
| Wiki   | Human-readable financial memory               |
| Policy | Deterministic permission and approval logic   |
| Agent  | Proposal/action orchestration                 |
| Audit  | Immutable proof of what happened and why      |

See `Brain_MVP_Architecture.md` for the v0.3 blueprint,
`Brain_API_Specification.yaml` for the v0.2 public contract, and
`Brain_Engineering_Standards.md` v0.2.0 for the conventions this repo
enforces — including the §6 deterministic pre-execution gate that every
financial action must pass.

## Repository layout

```
brain/
├── services/
│   ├── api/              # TypeScript. Public HTTP API gateway. Hosts shared primitives.
│   ├── raw/              # TypeScript. Ingestion workers (Layer 1).
│   ├── ledger/           # TypeScript. Normalized financial truth (Layer 2).
│   ├── wiki/             # TypeScript. Memory pages, search, Q&A (Layer 3).
│   ├── policy/           # TypeScript. Rule VM and evaluator (Layer 4).
│   ├── agent/            # TypeScript. Proposals, PaymentIntents, MCP (Layer 5). [renamed from execution]
│   ├── audit/            # TypeScript. Append-only log + Merkle anchor publisher (Layer 6).
│   └── agents/           # Python. Extractors, reasoners, the three MVP agents.
├── contracts/            # Solidity + Foundry. The four smart contracts.
├── infra/                # Terraform. Azure resource definitions.
├── schemas/              # JSON Schemas per Ledger entity, per Wiki page type.
├── clients/              # Generated typed clients for each service.
├── tests/
│   ├── unit/             # Co-located with source in each workspace.
│   ├── integration/      # Cross-service. Run against real deps in containers.
│   └── e2e/              # Full-stack against staging environment.
└── tools/                # Dev scripts, migration runners, backfill utilities.
```

`services/execution/` remains in-tree during the v0.3 transition and
re-exports from `services/agent/`. Migrate imports during normal-cadence PRs.

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

| Service    | URL                                                 |
| ---------- | --------------------------------------------------- |
| Postgres   | `postgres://brain:brain@localhost:5432/brain`       |
| Redis      | `redis://localhost:6379`                            |
| LocalStack | `http://localhost:4566` (Azure Blob-equivalent S3)  |

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
Normalized Ledger layer and the §6 pre-execution gate. Each stage and each
refactor phase is plan-first, human-approved, then a series of small
reviewed commits.

| Stage      | Deliverable                                                          |
| ---------- | -------------------------------------------------------------------- |
| 0          | Repository scaffolding                                               |
| 1          | Shared primitives (errors, auth, idempotency, observability)         |
| 2          | Raw layer — 5 endpoints + 5 source adapters                          |
| 3          | Wiki layer (v0.1 shape)                                              |
| 4          | Policy layer — 6 endpoints, rule VM, EIP-712 signing                 |
| 5          | 4 smart contracts on Base                                            |
| 6          | Execution layer (v0.1 shape)                                         |
| 7          | Audit layer — 5 endpoints, Merkle anchor publisher                   |
| 8          | Terraform infrastructure + CI/CD pipelines                           |
| 9          | End-to-end proof test suites                                         |
| refactor-1 | Six-layer doc realignment (this PR)                                  |
| refactor-2 | Ledger scaffolding (workspace + 11 migrations + read-only API)       |
| refactor-3 | Migrate financial truth from Wiki → Ledger; rewrite Plaid extractor  |
| refactor-4 | PaymentIntent + §6 pre-execution gate                                |
| refactor-5 | Reconciliation engine + Wiki page generation from Ledger             |
| refactor-6 | Invariant tests + golden-path dataset                                |

Progress is tracked via PRs labeled `stage-N` or `refactor-N`.

## Support

- API docs: `Brain_API_Specification.yaml` (browsable via Swagger UI or Redoc)
- Error code registry: `services/api/src/errors.ts` (lands in stage-1)
- Runbooks: `docs/` (populated from stage-8 onward)
