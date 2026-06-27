---
hidden: true
---

# Changelog

User-visible changes to the Brain protocol, HTTP API, MCP surface, and SDK. Internal refactors, performance work, and bug fixes that don't change behaviour are omitted unless they affect integrators.

### v0.5.8 (surface approval audit ordering + OpenAPI cleanup)

Safety and contract-polish release. No endpoint behavior is loosened.

#### Fixed. Surface approval ordering

- **Surface approval signatures now happen after the decision audit record.**
  Slack, Teams, and email approval flows re-check policy first, write the audit
  record, then record the approval signature that contributes to quorum. This
  keeps quorum-changing approval writes from preceding the audit evidence for
  the same human decision.
- **Dual approval still records the first approver.** The post-audit approval
  hook runs for both awaiting-second-approval and terminal approvals, so quorum
  can build without moving signing into the execution handoff.
- **Approver role checks are stricter.** A roleless actor no longer satisfies a
  `signer` sentinel, and disabled users no longer count as active approvers.

#### Changed. OpenAPI contract quality

- **OpenAPI lint now runs clean with zero warnings.** The contract now includes
  proprietary license metadata, explicit documented error responses for
  operations that only listed success responses, and regenerated SDK types.
- **Intentional route-shape exceptions are documented in Redocly config.** The
  implemented Fastify routes retain their existing paths, and the disabled
  legacy `POST /v1/execution/execute` route remains documented as returning
  `422` rather than a fake success response.

### v0.5.7 (money-path reservation lifecycle)

Safety hardening for the PaymentIntent execution path. No API, MCP, or SDK
surface changed.

#### Fixed. Reservation-backed execution handoff

- **Balance reservations now have a live lifecycle.** For ledger-account-backed
  payments, `execute()` locks the source account, locks the latest balance
  snapshot, rechecks available balance net of active reservations, then creates a
  reservation in the same transaction that moves the PaymentIntent from
  `approved` to `dispatching` and enqueues the durable outbox row. The outbox row
  stores `reservation_id`; settlement consumes the reservation, and deterministic
  rail failure releases it. Check #8 already subtracted active reservations, and
  the locked recheck makes the handoff race-free.
- **Outbox and PaymentIntent state races fail closed.** Settlement now verifies
  that `dispatching -> executed` actually updated the PaymentIntent before
  appending the execution receipt, consuming the reservation, or recording
  spend. Deterministic failure similarly verifies `dispatching -> failed` before
  releasing a reservation. A lost race routes the worker to retry/reconcile
  instead of producing a mismatched outbox/PaymentIntent state.
- **Outbox idempotency fallback is tenant-scoped.** The conflict lookup now
  selects by both `tenant_id` and `idempotency_key`, matching the unique index
  and preserving correctness outside strict RLS test environments.
- **Readiness evidence is profile-gated.** `production-readiness --profile`
  now treats evidence strength as a release gate, not only a display field.
  Staging requires exercised core safety rows such as Base Sepolia on-chain E2E;
  mainnet requires exercised money-path, rail, audit, and contract evidence. A
  new `pnpm run readiness:evidence -- --profile staging` command emits a
  diligence-ready report with row status, evidence state, blockers, and known
  limitations.

#### Changed. Boot composition

- Production DB role expectations moved out of `services/api/src/main.ts` into
  a focused composition module. Runtime behavior is unchanged; the boot binary
  is smaller and the role matrix is easier to review.

### v0.5.6 (docs-accuracy remediation + error `docs_url`)

Documentation-accuracy pass across the published docs, reconciling them to the code as the source of truth: the §6 gate-check count (13 numbered + 10 hardening = 23), the MCP scope error code (`-32002`, not `-32004`), the route migration table (`/execution/*` propose/register stay live; `/agents/{id}/propose` and `/agents/register` 404), the MCP surface size (12 tools / 7 resources / 5 prompts), the self-serve signup path (`POST /v1/signup`), the credential model (`brain_sk_` is the bearer service token), the decision/status vocabularies (`allow|confirm|reject` and their SDK aliases), the webhook event catalog (`payment_intent.*`), and the deployed Base Sepolia contract addresses. No API / MCP / SDK behavior changed except the item below.

#### Changed. Error envelope `docs_url`

- **`error.docs_url` now points at the published error reference.** It previously emitted `https://docs.brain.fi/errors/{code}`, a path with no page (every self-help link 404'd). It now emits `https://docs.brain.fi/resources/errors#{code}`, which lands on the canonical error registry.

### v0.5.5 (GDPR erasure hardening)

Second-pass review remediation of the tenant blob-purge workflow (RFC 0003). Compliance- and diligence-facing; the internal worker/test detail is omitted.

#### Changed. Tenant erasure is now crash-safe and audit-atomic

- **A crashed purge worker can no longer silently strand a GDPR Article 17 erasure.** A job claimed by a worker that then dies (left in `purging`) is now reclaimed by another worker once its lease expires, and every status write is fenced on a unique lock token so a resurrected stale worker cannot overwrite the new owner's result.
- **A transient cloud error no longer masquerades as a permanent legal hold.** Per-object delete failures are classified: throttling / 5xx / network / authorization errors are retried, and only a confirmed WORM / object-lock response makes the job terminal (`blocked_legal_hold`). Previously any failed delete was treated as a legal hold, so a 503 could permanently stop an erasure.
- **Purge-lifecycle audit events are now written transactionally.** Each state transition records its audit intent in the same database transaction as the status change (via an outbox), and a publisher delivers it to the audit service idempotently. This removes the prior ordering where an audit event could be emitted before the state write (orphaning a "completed" record) and the `audit-emit-failed` sentinel that let a job complete with no real audit event. A tenant deletion now returns a truthful committed result even if the audit service is momentarily unavailable.

### v0.5.4 (audit-build binding, GDPR erasure, money-path CI)

Review-remediation batch. The internal CI/test work is omitted; the items below are API-, compliance-, or diligence-facing.

#### Fixed. Proof API

- **`GET /v1/proof/{action_id}` no longer 500s for an in-flight payment.** A PaymentIntent that is executed but still `dispatching` (settlement async, not yet anchored) now returns a **200 partial proof** (gate checks present, `merkle_root` empty until anchored) instead of an internal error. Root cause was a never-run-on-Postgres evidence query referencing non-existent columns. `policy_hash` is now hex-encoded (was a raw byte buffer).

#### Added. GDPR Article 17 erasure (RFC 0003)

- **Tenant deletion now durably and permanently erases Raw blob bytes.** `DELETE /v1/tenants/{id}` enqueues a `tenant_blob_purge_jobs` row in the deletion transaction; a privileged worker drains it via `BlobAdapter.purgeTenant` with bounded retries, a dead-letter state, legal-hold surfacing, and per-lifecycle audit events (`tenant_blob.purge_requested` / `_completed` / `_blocked_legal_hold` / `_retried` / `_exhausted`). `purgeTenant` does version-aware deletion (S3 every object version + delete marker; Azure versions + snapshots), so erasure is permanent in a versioned bucket, closing the gap where a "deleted" response left the user's PII recoverable.

#### Changed. Mainnet escrow audit binding (diligence)

- **Audit approval binds to the audited build, not just a commit.** `contracts/audit-status.json` approval now additionally requires the compiler settings, contract-source-tree hash, and creation/runtime bytecode hashes, plus an explicit `approved_chain_ids`. A CI step recomputes them from the working tree + Foundry artifact and fails the build on drift; the mainnet escrow boot fence also requires the booting chain to be in `approved_chain_ids`. A single shared validator now backs the runtime fence, the CI guard, and the readiness command (previously the runtime path was a bare `status === "approved"` check).
- **The mainnet escrow boot fence now also verifies the DEPLOYED on-chain bytecode.** With an escrow address configured on Base mainnet, the api reads the live contract code via `eth_getCode` and refuses to boot unless it matches the audited runtime bytecode. Because Solidity writes `immutable` values (the escrow arbiter) into the deployed code at construction, the audited hash and the on-chain code are compared with those immutable byte ranges masked; an approved `contracts/audit-status.json` now carries the masked `runtime_bytecode_sha256` plus the `immutable_references` ranges. A wrong, unaudited, or tampered deployment becomes a refused boot rather than a silent funds-custody risk.

### v0.5.3 (CI + demo integrity)

Internal hardening. No API, protocol, MCP, or SDK surface change. Recorded here because it restores an end-to-end proof artifact integrators rely on, and one item affects anyone bootstrapping the schema.

#### Fixed. CI + golden-path

- **The golden-path smoke runs end-to-end as a post-merge CI gate again.** Its job depends on the unit+integration job, which had been red on an unrelated, masked test-schema failure, so the smoke was silently skipped and the full `seed → ingest → normalize → propose → policy → execute → proof` chain was not actually exercised in CI. The prerequisite suite is green again and the smoke passes front to back (propose → `approved` → execute → `dispatching`).
- **The demo seed no longer trips the §6 duplicate-payment gate (check 11.5).** A freshly-seeded counterparty's payment instructions were stamped `now()`, which the `destination_recently_changed` rule correctly reads as a vendor-account-swap signal. The seed's backdate mitigation had been scoped to the on-chain recipient only; it now backdates every seeded counterparty for the tenant, so the default ACH demo settles cleanly. The §6 gate itself is unchanged and still fail-closed.
- **The migration set is self-contained for `pgcrypto`.** A migrations-only bootstrap (for example a test schema that does not run the `postgres-init` extension script) now creates `pgcrypto` via migration `0031`, so the migration `0027` payment-instruction trigger's `digest()` call resolves instead of failing at first insert. This affects anyone building a schema from the migration set alone.

### v0.5.2 (control-plane hardening)

Follow-up review fixes. All stricter / fail-closed.

#### Changed. Safer defaults + provenance

- **The default tenant policy never auto-executes money.** A freshly provisioned tenant's default now requires human **confirmation** for `outbound_payment` / `onchain_tx` above the confidence floor (with a single-signer approval); non-money actions still auto-allow. The prior blanket `auto` rule (which the repo's own policy linter flags as unsafe-for-money) is gone. A tenant signs a constrained autonomy policy to earn unattended money movement.
- **High-trust provider source types are reserved to authenticated ingestion.** `source_type: "plaid"` / `"stripe"` are refused on the generic `/raw/ingest` route with `raw_source_reserved` (403); they may only arrive via the HMAC-verified `/raw/webhooks/{provider}` path, so a `raw:write` caller can't mint high-trust evidence by choosing the label.

#### Fixed. Audit-control plumbing

- The committed `contracts/audit-status.json` now ships in the production image, so the mainnet escrow boot fence can actually pass once the audit is approved (previously it was excluded and failed closed forever).
- `pnpm run production-readiness` now models the same two-part mainnet-escrow condition as the runtime boot fence (committed approved record **and** env attestation), so the report can no longer show green for a deployment the runtime would reject.

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

- `POST /v1/signup`. Open, sandbox-first tenant + owner creation (email + password). Returns a verification token directly only outside production (no email provider wired yet). Registered only when `BRAIN_SELF_SERVE_SIGNUP` is enabled; returns 404 when the flag is off.
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
- **Pre-execution gate.** Deterministic check against live Ledger state before any payment executes: 13 numbered checks plus 10 hardening additions (23 entries total; several record `not_applicable` until their loaders are wired). See [the pre-execution gate](../protocol/the-pre-execution-gate.md).
- **MCP server.** `POST /v1/agents/mcp`, JSON-RPC 2.0 over single-shot HTTP. 12 tools, 7 resource templates, 5 canned prompts.
- **Agent contributions.** External agents with `raw:write` scope can push artifacts into the Raw layer with cryptographic attribution.
- **`/v1/audit/entity/{type}/{id}` endpoint.** Pull every audit event that touched a specific Ledger row.

### Changed

- **Ledger is now the source of truth.** Wiki is downstream of Ledger and regenerable from Ledger plus Raw at any time.
- **Wiki no longer authoritative for financial state.** Wiki holds human-readable memory only; balances, transactions, and obligations come from Ledger.
- **Execution renamed to Agent.** The Agent layer covers proposal, scope enforcement, and the propose-only MCP surface.
- **Routes added.** `/payment-intents/*`, `/agents/run`, and `/agents/mcp` are the v0.3 paths that are mounted today. The legacy `/execution/*` routes remain **live and fully supported**: the generic propose/approve flow (`/execution/propose`, `/execution/approve`) and external-agent registration (`/execution/agents/register`) still run through them and have no v0.3 replacement. The reserved `/agents/{id}/propose` and `/agents/register` paths appear in the OpenAPI spec but are **not yet implemented and return 404**; do not migrate to them.

### Six Layers (Was Five)

- The previous protocol had five layers: Raw, Wiki, Policy, Execution, Audit.
- The current protocol has six: Raw, **Ledger**, Wiki, Policy, **Agent** (renamed from Execution), Audit.

## Migration from the Previous Version

| If you were using              | Use instead                                                              |
| ------------------------------ | ------------------------------------------------------------------------ |
| `/execution/propose`           | Still live (no replacement); or `/agents/run` for routed agent proposals |
| `/execution/execute`           | `/payment-intents/{id}/execute`                                          |
| `/execution/agents/register`   | Still live (no replacement); `/agents/register` is not yet implemented   |
| `/execution/mcp`               | `/agents/mcp`                                                            |
| Wiki for current balances      | `brain.accounts.list` (Ledger)                                           |
| Wiki for transaction filtering | `brain.transactions.list` (Ledger)                                       |

Only `/execution/execute` and `/execution/mcp` have v0.3 replacements; both carry `Deprecation`/`Sunset` headers. The propose/approve and agent-registration routes under `/execution/*` are **not deprecated** and remain the supported path.

## Earlier: Five-Layer Protocol

- Five layers: Raw, Wiki, Policy, Execution, Audit.
- Wiki was the source of truth for financial state.
- MCP surface lived under `/execution/mcp`.
