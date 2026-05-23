---
hidden: true
---

# Changelog

User-visible changes to the Brain protocol, HTTP API, MCP surface, and SDK. Internal refactors, performance work, and bug fixes that don't change behaviour are omitted unless they affect integrators.

### v0.4 (Agent Autonomy v3)

Hardens the 19-agent internal library for production autonomous execution. **Money-movers stay shadowed by default** — going live is a deliberate, per-agent promotion (strict caps + allowlisted rails); no agent moves money until promoted.

#### Added — HTTP API

- `POST /v1/agents/route` — routing decision only (no run).
- `POST /v1/agents/run` — route → resolve action → dry-run gate → persist run → propose (shadow-aware; a shadowed agent's financial proposal terminates as `shadow_completed`).
- `POST /v1/agents/events` — enqueue an event-driven route/run job.
- `GET /v1/agents/runs`, `GET /v1/agents/runs/{run_id}`, `GET /v1/agents/runs/{run_id}/why` — run history + the structured-reason / trace / gate / receipt bundle.
- `GET /v1/agents/routing-decisions/{id}` — routing decision detail.
- `POST /v1/agents/{agent_id}/halt`, `POST /v1/agents/halt-category` — kill-switch: pause an agent's in-flight intents + quarantine it, or emergency-stop a whole category.
- `POST /v1/payment-intents/{id}/pause`, `POST /v1/payment-intents/{id}/resume` — pause/resume an approved intent (resume re-runs the live §6 gate).
- `GET /v1/payment-intents/{id}/replay-investigation` — typed forensic record (intent + executions + rail receipts + linking ids).

#### Added — Policy DSL (signed)

- `agent.id`, `tenant.category`, `action.in` / `action.not_in`, `agent.behaviorHash`, `agent.spend_in_window`, `agent.tx_count_in_window`, and rule-level `approval_required_above`. All covered by the policy content hash, so they're signed.

#### Added — Smart contracts

- `BrainSmartAccount.pauseSessionKey(holder)` / `unpauseSessionKey(holder)` — disable execution while preserving the key record, window spend, limits, and metadata (distinct from `revokeSessionKey`, which is permanent removal).
- `BrainMCPAgentRegistry.registerAgent` now takes a `behaviorHash`; `updateBehaviorHash(...)` re-attests on a model/prompt/tool change. The §6 gate adds check 1.5 (runtime `behaviorHash` must match the registered value).

#### Changed

- `Agent.state` adds `quarantined` (additive enum widening).
- Typed rail receipts (`ach` / `wire` / `erp` / `onchain`): the audit-after step refuses to commit unless the receipt validates against the rail's schema.

#### Errors

- `agent_proposal_duplicate` (409) — proposal-layer idempotency collision.

#### SDK (`@brain/sdk`)

- New `agents.route/run/enqueueEvent/listRuns/getRun/why/getRoutingDecision/halt/haltCategory` and `payments.pause/resume/replayInvestigation`. Generated types regenerated from the OpenAPI spec.

### v0.3.1 (poc-investor-demo)

#### Breaking changes

- **`BRAIN_DEMO_MODE` env var now requires literal `"true"` or `"false"`.** Previously `z.coerce.boolean()` silently coerced `"false"`, `"0"`, `"no"` to `true`. Update any `.env` or CI config using those forms.
- **`Brain.getMaskedApiKey()` renamed to `getMaskedToken()`.** Follows the `apiKey → token` rename in this release.

#### Added

- `Dockerfile` — multi-stage build for the `brain-server` single-process boot binary.
- `GET /v1/demo/token` — mints a 15-minute read-heavy JWT for the golden demo tenant (requires `BRAIN_DEMO_MODE=true`, refused in `NODE_ENV=production`).
- `POST /v1/audit/anchor/publish` — on-demand anchor trigger (requires `audit:admin`, 60s per-tenant cooldown).
- Live viem anchor broadcaster — `AUDIT_PUBLISHER_KEY` + `AUDIT_ANCHOR_ADDRESS` wires on-chain anchoring to Base Sepolia.
- `CORS_ALLOWED_ORIGINS` config variable — replaces the previous reflect-any-origin behaviour.
- `tools/demo-reset` — wipes and re-seeds golden-path demo-tenant business entities; audit log preserved.

## Current: Six-Layer Protocol with MCP

The current release introduces a Normalized Ledger between Raw and Wiki, splits Execution into a dedicated Agent layer, and adds the MCP server.

### Added

- **Normalized Ledger layer.** Eleven entities: accounts, balances, transactions, counterparties, obligations, documents, categories, transfers, invoices, payment intents, reconciliation matches.
- **Payment Intents.** Agent-proposed financial actions live as Ledger rows, queryable like any other entity.
- **Pre-execution gate.** Deterministic 13-step check against live Ledger state before any payment executes.
- **MCP server.** `POST /v1/agents/mcp`, JSON-RPC 2.0 over single-shot HTTP. 10 tools, 5 resource templates, 5 canned prompts.
- **Agent contributions.** External agents with `raw:write` scope can push artifacts into the Raw layer with cryptographic attribution.
- **`/v1/audit/entity/{type}/{id}` endpoint.** Pull every audit event that touched a specific Ledger row.

### Changed

- **Ledger is now the source of truth.** Wiki is downstream of Ledger and regenerable from Ledger plus Raw at any time.
- **Wiki no longer authoritative for financial state.** Wiki holds human-readable memory only; balances, transactions, and obligations come from Ledger.
- **Execution renamed to Agent.** The Agent layer covers proposal, scope enforcement, and the propose-only MCP surface.
- **Routes renamed.** `/agents/*`, `/payment-intents/*`, and `/agents/mcp` are the canonical paths. Legacy `/execution/*` routes continue to work with deprecation headers.

### Six Layers (Was Five)

- The previous protocol had five layers: Raw, Wiki, Policy, Execution, Audit.
- The current protocol has six: Raw, **Ledger**, Wiki, Policy, **Agent** (renamed from Execution), Audit.

## Migration from the Previous Version

| If you were using              | Use instead                        |
| ------------------------------ | ---------------------------------- |
| `/execution/propose`           | `/agents/{id}/propose`             |
| `/execution/execute`           | `/payment-intents/{id}/execute`    |
| `/execution/agents/*`          | `/agents/*`                        |
| `/execution/mcp`               | `/agents/mcp`                      |
| Wiki for current balances      | `brain.accounts.list` (Ledger)     |
| Wiki for transaction filtering | `brain.transactions.list` (Ledger) |

Legacy routes are supported through 2026-Q2 with `Deprecation` and `Sunset` headers attached to every response.

## Earlier: Five-Layer Protocol

- Five layers: Raw, Wiki, Policy, Execution, Audit.
- Wiki was the source of truth for financial state.
- MCP surface lived under `/execution/mcp`.
