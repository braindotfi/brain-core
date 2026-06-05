---
hidden: true
---

# Changelog

User-visible changes to the Brain protocol, HTTP API, MCP surface, and SDK. Internal refactors, performance work, and bug fixes that don't change behaviour are omitted unless they affect integrators.

### v0.5.1 (autonomy + provenance hardening)

A safety-hardening batch. All changes are stricter (fail-closed), never more permissive.

#### Changed. Tighter defaults + authorization

- **Default confidence floor raised to `0.6`.** A freshly provisioned tenant's default policy now rejects auto-execution of an intent backed only by an uncorroborated, document-extracted obligation (capped at `0.5`); a corroborated obligation (reconciliation lifts it to ~`0.7`+) still passes. Tenants with their own signed policy are unaffected.
- **Signed per-agent action allowlist (`PolicyDocument.agent_actions`) is now enforced on every action-resolution path** (explicit request, event map, intent-classifier match, and default action), not just explicit requests. A denied action can no longer be smuggled in via an event mapping or a default.
- **Evidence trust derives from the raw artifact's `source_type`**, not the caller-chosen parser label, so a `raw:write` principal can no longer mint high-trust evidence by labelling its parser `plaid`/`stripe`.

#### Added. Obligation-direction safety

- **`obligation_direction_invalid` (422).** A new obligation-linked PaymentIntent must target a known `payable` obligation; a `null`/unknown or `receivable` (wrong-way) direction is refused at creation. The §6 gate's check 6.7 continues to reject `receivable` at execute for already-created intents.

#### Added. Operational / diligence

- **`contracts/audit-status.json`** is the committed source of truth for the external smart-contract audit; mainnet escrow now boots only when that record says `approved` (a bare env flag no longer bypasses a pending audit).
- **`BlobAdapter.purgeTenant`** primitive for GDPR Art. 17 tenant erasure (deletes Raw bytes under a tenant prefix; WORM/legal-hold-protected blobs are surfaced, not force-deleted).

### v0.5 (M2M Commerce + Self-Serve Onboarding)

Two additive tracks: **machine-to-machine (M2M) agent commerce** (RFC 0001) and **self-serve onboarding** (RFC 0002). Everything money-moving here is **shadow-first / fail-closed**. The new settlement rails are unregistered at boot and the new contracts are unaudited testnet/reference code. Self-serve signup is gated behind `BRAIN_SELF_SERVE_SIGNUP` (default off, sandbox-first).

#### Added. Self-serve onboarding (RFC 0002)

- `POST /v1/auth/signup`. Open, sandbox-first tenant + owner creation (email + password). Returns a verification token directly only outside production (no email provider wired yet).
- `POST /v1/auth/verify-email`. Verify the owner's email with the issued token.
- `POST /v1/auth/login`. Email + password login for the human owner; mints an owner JWT.
- `POST /v1/tenants/{tenant_id}/wallets`. Link a wallet to a tenant; a linked wallet can then sign in over SIWX as the owner.
- Agent on-chain registration is async: a newly registered agent starts `pending_onchain` and a relayer submits the `BrainMCPAgentRegistry` registration (the relayer is fail-closed until configured).

#### Added. M2M / x402 settlement (RFC 0001)

- `x402_settle` action type. USDC-on-Base settlement via the `x402_base` rail.
- `escrow_release` action type. Milestone / dispute-split release via the `escrow_base` rail (`BrainEscrow`).
- Both settlement rails are **unregistered at boot and fail closed** until promoted; they throw rather than fake-settle.
- Five dormant-until-wired §6 gate checks (3.5 on-chain-settlement-permitted, 5.5 agent-counterparty-attested, 6.5 x402-payment-context, 6.6 escrow-state-bound, 8.5 micropayment-cap-in-window). Each adds a row only when the intent carries settlement/escrow context **and** its on-chain loader is configured; the canonical path is unchanged for non-settlement payments.
- On-chain-settlement reconciliation matcher; agent counterparties; `chain_tx_hash` on `ledger_transactions`.

#### Added. Smart contracts (Base; unaudited)

- `BrainEscrow`. Custodial escrow with partial release, refund, and dispute splits (**UNAUDITED reference implementation**, testnet only).
- `BrainReputationRegistry`. An ERC-8004-style per-agent reputation pointer / score root (RFC 0001, **UNAUDITED testnet**). Policy reads it as a **tighten-only** threshold input. Never a money gate or a §6 precondition.

#### Errors

- `signup_email_taken` (409), `signup_token_invalid` (400), `wallet_already_linked` (409), `auth_invalid_credentials` (401), `auth_email_unverified` (403).

### v0.4 (Agent Autonomy v3)

Hardens the 19-agent internal library for production autonomous execution. **Money-movers stay shadowed by default**. Going live is a deliberate, per-agent promotion (strict caps + allowlisted rails); no agent moves money until promoted.

#### Added. HTTP API

- `POST /v1/agents/route`. Routing decision only (no run).
- `POST /v1/agents/run`. Route → resolve action → dry-run gate → persist run → propose (shadow-aware; a shadowed agent's financial proposal terminates as `shadow_completed`).
- `POST /v1/agents/events`. Enqueue an event-driven route/run job.
- `GET /v1/agents/runs`, `GET /v1/agents/runs/{run_id}`, `GET /v1/agents/runs/{run_id}/why`. Run history + the structured-reason / trace / gate / receipt bundle.
- `GET /v1/agents/routing-decisions/{id}`. Routing decision detail.
- `POST /v1/agents/{agent_id}/halt`, `POST /v1/agents/halt-category`. Kill-switch: pause an agent's in-flight intents + quarantine it, or emergency-stop a whole category.
- `POST /v1/payment-intents/{id}/pause`, `POST /v1/payment-intents/{id}/resume`. Pause/resume an approved intent (resume re-runs the live §6 gate).
- `GET /v1/payment-intents/{id}/replay-investigation`. Typed forensic record (intent + executions + rail receipts + linking ids).

#### Added. Policy DSL (signed)

- `agent.id`, `tenant.category`, `action.in` / `action.not_in`, `agent.behaviorHash`, `agent.spend_in_window`, `agent.tx_count_in_window`, and rule-level `approval_required_above`. All covered by the policy content hash, so they're signed.

#### Added. Smart contracts

- `BrainSmartAccount.pauseSessionKey(holder)` / `unpauseSessionKey(holder)`. Disable execution while preserving the key record, window spend, limits, and metadata (distinct from `revokeSessionKey`, which is permanent removal).
- `BrainMCPAgentRegistry.registerAgent` now takes a `behaviorHash`; `updateBehaviorHash(...)` re-attests on a model/prompt/tool change. The §6 gate adds check 1.5 (runtime `behaviorHash` must match the registered value).

#### Changed

- `Agent.state` adds `quarantined` (additive enum widening).
- Typed rail receipts (`ach` / `wire` / `erp` / `onchain`): the audit-after step refuses to commit unless the receipt validates against the rail's schema.

#### Errors

- `agent_proposal_duplicate` (409). Proposal-layer idempotency collision.

#### SDK (`@brain/sdk`)

- New `agents.route/run/enqueueEvent/listRuns/getRun/why/getRoutingDecision/halt/haltCategory` and `payments.pause/resume/replayInvestigation`. Generated types regenerated from the OpenAPI spec.

### v0.3.1 (poc-investor-demo)

#### Breaking changes

- **`BRAIN_DEMO_MODE` env var now requires literal `"true"` or `"false"`.** Previously `z.coerce.boolean()` silently coerced `"false"`, `"0"`, `"no"` to `true`. Update any `.env` or CI config using those forms.
- **`Brain.getMaskedApiKey()` renamed to `getMaskedToken()`.** Follows the `apiKey → token` rename in this release.

#### Added

- `Dockerfile`. Multi-stage build for the `brain-server` single-process boot binary.
- `GET /v1/demo/token`. Mints a 15-minute read-heavy JWT for the golden demo tenant (requires `BRAIN_DEMO_MODE=true`, refused in `NODE_ENV=production`).
- `POST /v1/audit/anchor/publish`. On-demand anchor trigger (requires `audit:admin`, 60s per-tenant cooldown).
- Live viem anchor broadcaster. `AUDIT_PUBLISHER_KEY` + `AUDIT_ANCHOR_ADDRESS` wires on-chain anchoring to Base Sepolia.
- `CORS_ALLOWED_ORIGINS` config variable. Replaces the previous reflect-any-origin behaviour.
- `tools/demo-reset`. Wipes and re-seeds golden-path demo-tenant business entities; audit log preserved.

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
