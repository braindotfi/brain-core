# Brain Engineering Standards

Brain Finance Inc. | v0.4.0 MVP

This document defines the conventions every engineer, contractor, and AI coding assistant follows when building Brain. It is the decision log that keeps the codebase consistent and the production-posture credible.

Read alongside: Brain_API_Specification.yaml (the OpenAPI contract) and Brain_MVP_Architecture.md (the protocol blueprint, v0.4 = six layers).

### What Changed In v0.4.0

v0.4.0 records the hardening wave on top of the v0.3 six-layer architecture. The model is unchanged; the safety surfaces are sharpened:

- §6 pre-execution gate is now **13 numbered checks + 4 hardening additions** (17 entries). The four sub-checks `1.5` (agent behavior pinned), `7.5` (ledger-state binding, H-08), `9.5` (evidence semantics, H-21), and `11.5` (duplicate-payment hard reject, H-22) join the original 13. The audit-before event persists the full check trace (H-07). See §6.2.1.
- §6.5 documents **shadow-by-default + the promotion-readiness gate** (H-24): an agent cannot go live without `scripts/check-promotion-readiness.mjs` all-green, enforced in CI on `promotion-config.ts` diffs.
- Execution is now a **durable outbox** (H-04): `execute` enqueues + transitions `approved → dispatching`; an outbox worker dispatches the rail and settles. New `dispatching` PaymentIntent status.
- New trust surfaces: the **Proof API** (`GET /v1/proof/{action_id}`, H-07) and **Agent Run History** (`/v1/agents/runs/{run_id}/*`, H-25).
- Outbound webhooks gained a **dead-letter queue + replay** (`/v1/webhooks/{endpoint_id}/{dead-letters,replay}`, H-20) instead of dropping failed deliveries.
- **Policy governance tooling** (H-18): `POST /v1/policy/{tenant_id}/{lint,diff,simulate-historical}`. Static lint (amount cap / counterparty / approval-path / currency / role / risk rules), version diff, and historical replay before signing.
- **Policy DSL agent-output primitives** (H-16): `agent.confidence.gte`, `agent.evidence_score.gte`, `agent.risk_level.lte`. Policy can now gate on an agent's canonical `AgentOutput` (confidence / evidence_score / risk_level). These are `when` keys in the DSL, not `{layer}:{verb}` scopes.
- **Agent capability manifests** (H-15): a canonical `AgentManifest` (schemas/agent-manifest.schema.json) derived per internal agent; MCP external-agent registration requires + scope-hash-validates a manifest.
- **Domain event bus** (H-17): a Postgres LISTEN/NOTIFY `domain_events` substrate for runtime fan-out (durability still comes from the audit log).

### What Changed In v0.2.0

v0.2.0 of this document realigns to the v0.3 architecture (six layers). Specifically:

- §1 adds a fifth principle: deterministic pre-execution gate.
- §2 repo layout adds `services/ledger/`; a planned `services/execution/` directory rename to the Agent-layer name was **not** carried out. The workspace stays `services/execution/` (the Agent layer, layer 5).
- §3.2 scope list updated: `ledger:*`, `payment_intent:*`, `agent:*`.
- §4.3 error code registry adds ledger and payment*intent codes; `execution*\_`codes alias to`agent\_\_` for back-compat.
- §6 Pre-execution gate is a NEW SECTION (renumbers Observability → §7, Testing → §8, etc.).
- §9.5 PaymentIntent state machine is new.
- §11 dependencies adds Chainalysis as the deterministic counterparty-verification provider.

The §1 principles, the audit chain, and the v0.1.0 §3.1 auth model are otherwise unchanged.

## 1. Non-Negotiable Principles

Five principles override every implementation preference. If a trade-off question comes up and these are on one side, they win.

**Provenance on everything.** Every derived fact in the Ledger and the Wiki carries provenance, confidence, and a pointer to source evidence. No exceptions. A row without those three fields is a bug, regardless of how convenient it would be to skip them.

**Tenant isolation at the storage layer, not the query layer.** Row-level security on every Postgres table. Per-tenant path prefixes in Azure Blob. A bug in application code must not be able to leak cross-tenant data. Shared-query-with-filter is not an acceptable pattern for tenant-scoped data.

**Idempotency by default on writes.** Every write endpoint accepts an idempotency key or derives one from content. Retries are safe. Duplicate events are detected. This is required for webhook reliability and for agent retry behavior.

**Audit everything that matters.** Every API call, Ledger write, policy evaluation, agent action, and state transition produces an audit event. The audit log is append-only and Merkle-chained. If it is not in the log, it did not happen.

**Deterministic pre-execution gate.** No financial execution path may bypass the §6 gate. Policy evaluation reads from Ledger state, not Wiki text. LLM judgment never replaces a deterministic precondition check on money movement. (See §6.)

## 2. Repository Layout

One monorepo. Language-specific workspaces inside. Workspaces publish typed clients to each other.

```
brain/
├── services/
│   ├── api/              # TypeScript. Public HTTP API gateway (auth/webhook/MCP wiring + boot).
│   ├── raw/              # TypeScript. Ingestion workers (Layer 1).
│   ├── ledger/           # TypeScript. Normalized financial truth (Layer 2). [v0.3]
│   ├── wiki/             # TypeScript. Memory/Q&A. Pages derived from Ledger (Layer 3).
│   ├── policy/           # TypeScript. Rule VM and evaluator (Layer 4).
│   ├── execution/        # TypeScript. Proposal/PaymentIntent orchestration (Layer 5).
│   ├── mcp/              # TypeScript. JSON-RPC MCP server (Layer 5′).
│   ├── audit/            # TypeScript. Append-only log + Merkle anchor publisher (Layer 6).
│   ├── agent-router/     # TypeScript. Event/intent → internal-agent routing.
│   ├── internal-agents/  # TypeScript. First-party agent catalog (definitions + handlers).
│   └── agents/           # Python. Extractors, reasoners, the three MVP agents.
├── shared/               # TypeScript. @brain/shared. All cross-cutting primitives.
├── contracts/            # Solidity + Foundry. The four smart contracts.
├── infra/                # Terraform. Azure resource definitions.
├── schemas/              # JSON Schemas per Ledger entity, per Wiki page type.
├── clients/              # Generated typed clients for each service.
├── tests/
│   ├── unit/             # Co-located with source in each workspace.
│   ├── integration/      # Cross-service. Spin up containers, run against real deps.
│   └── e2e/              # Full-stack against staging environment.
└── tools/                # Dev scripts, migration runners, backfill utilities.
```

The Layer-5 service kept its original name `services/execution/` (the Agent layer, layer 5; the planned directory rename did not happen). It retains the v0.2 `/execution/*` routes (deprecated) alongside the v0.3 `/payment-intents/*` and `/actions/*` routes. Cross-cutting shared primitives live in the top-level `shared/` package (`@brain/shared`), not in `services/api`.

Every service owns its database schema. Cross-service reads go through the owning service's API, never direct database access. This is the rule that preserves the option to extract services later.

## 3. Authentication and Authorization

### 3.1 The Auth Model

Bearer JWT on every endpoint except three: `/raw/webhooks/{provider}` (HMAC-signed), `/audit/verify` (public, pure function), and the root health check.

JWT payload:

```json
{
  "iss": "https://auth.brain.fi",
  "sub": "user_01HQ7K3..." or "agent_01HQ7K3...",
  "tenant_id": "tnt_01HQ7K3...",
  "principal_type": "user" | "agent" | "api_partner",
  "scopes": ["ledger:read", "wiki:read", "policy:sign", "payment_intent:propose", ...],
  "exp": 1745000000,
  "jti": "token_01HQ7K3..."
}
```

Tokens are short-lived (15 minutes) and refreshed via a standard refresh-token flow. Refresh tokens rotate on every use. Revoked jti values are cached in Redis for the remainder of their original expiry window.

### 3.2 Scopes

Scopes are `{layer}:{verb}` strings. The verb is one of `read`, `write`, `admin`. Admin is only held by the tenant root user and is required for signing policies and registering agents.

Verb extensions for the Agent layer:

- `agent:propose`, create non-financial proposals
- `payment_intent:propose`, create PaymentIntent rows
- `payment_intent:approve`, sign approvals on `confirm`-mode PaymentIntents
- `payment_intent:execute`, trigger execution of an approved intent

External agents (`principal_type=agent`, registered in BrainMCPAgentRegistry) are granted scopes explicitly by the tenant at registration time via EIP-712 signature. The five scopes an external agent can hold are `ledger:read`, `wiki:read`, `raw:write` (for agent contributions), `payment_intent:propose`, and `agent:propose`. An agent granted `raw:write` can push artifacts into the Raw layer using `source_type=agent_contributed`. These artifacts flow through the extraction pipeline, but any derived **Ledger** rows carry `provenance=agent_contributed` and start at a confidence ceiling of 0.5 regardless of extractor certainty. Promotion above 0.5 requires independent corroboration or explicit tenant approval via `/wiki/annotate` (which writes through to the Ledger via a controlled service method). This governance boundary is enforced in the Ledger write path, not just documented here, and is non-negotiable.

Scope to endpoint mapping is enforced in the API gateway, not in individual services. Services trust the scopes in the JWT but re-verify tenant_id equality on every query.

### 3.3 Agent Identities

Every agent, internal or external, has its own JWT with `principal_type=agent`. The agent_id in the sub claim must match a row in the `agents` table. External agents registered via `/agents/register` (legacy: `/execution/agents/register`) receive their initial JWT immediately after the on-chain registration transaction confirms.

### 3.4 HMAC Webhooks

Each provider (Plaid, Stripe, NetSuite, Alchemy) has a provider-specific HMAC signature scheme. The `X-Brain-Signature` header is verified before the request body is parsed. Failed verification returns 401 and logs a security event. No exceptions.

## 4. Error Handling

### 4.1 The Error Envelope

Every non-2xx response body conforms to this shape:

```json
{
  "error": {
    "code": "policy_rule_invalid",
    "message": "Rule id 'high-value-check' has a malformed amount.gt clause",
    "details": {
      "rule_id": "high-value-check",
      "field": "amount.gt.value"
    },
    "request_id": "req_01HQ7K3...",
    "docs_url": "https://docs.brain.fi/errors/policy_rule_invalid"
  }
}
```

`code` is a stable machine-readable string. It never changes once shipped. Code strings follow `{domain}_{condition}` convention. See section 4.3 for the registry.

### 4.2 Status Code Mapping

Never return a 200 with an error in the body. HTTP status and error envelope are both mandatory and must agree.

### 4.3 Error Code Registry

Codes are defined in `shared/src/errors.ts` (the `@brain/shared` package) and regenerated into the OpenAPI spec. Adding a new code requires a PR that updates both. The registry:

```
// Auth
auth_token_missing, auth_token_invalid, auth_token_expired,
auth_scope_insufficient, auth_tenant_mismatch

// Validation
request_body_invalid, request_params_invalid, request_too_large

// Raw
raw_artifact_not_found, raw_artifact_tombstoned, raw_source_unsupported,
raw_webhook_signature_invalid

// Ledger (v0.2)
ledger_row_not_found, ledger_row_invalid, ledger_status_invalid,
ledger_balance_unavailable, ledger_evidence_required,
ledger_reconciliation_conflict

// Wiki
wiki_entity_not_found, wiki_page_not_found,
wiki_schema_validation_failed, wiki_temporal_range_invalid,
wiki_question_timeout

// Policy
policy_not_found, policy_rule_invalid, policy_quorum_not_met,
policy_signature_invalid, policy_version_mismatch,
policy_decision_required           // pre-execution gate: no decision was supplied

// Agent / PaymentIntent (v0.2)
// agent_* aliases supersede execution_* for the v0.3 transition.
agent_not_registered,                     // alias of legacy execution_agent_not_registered
agent_proposal_not_found,                 // alias of legacy execution_proposal_not_found
agent_proposal_invalid_state,             // alias of legacy execution_proposal_invalid_state
agent_rail_unavailable,                   // alias of legacy execution_rail_unavailable
agent_idempotency_conflict,               // alias of legacy execution_idempotency_conflict

payment_intent_not_found,
payment_intent_invalid_state,
payment_intent_gate_failed,               // pre-execution gate failed; details list the failing checks
payment_intent_approval_required,
payment_intent_approval_invalid,

// Approver / quorum hardening (P0.4)
approval_signer_revoked,                   // 403. Signer is no longer an active approver
approval_cross_tenant,                     // 403. Signer tenant does not own the subject
approval_duplicate_signer,                 // 409. Principal already signed this subject
approval_policy_stale,                     // 409. Signature was against a superseded policy version

// Invoice shortcut (P0.5). POST /payment-intents { type: pay_invoice }
invoice_shortcut_invalid,                  // 400. Malformed invoice_id / shortcut not enabled
invoice_shortcut_not_found,                // 404. Invoice missing or cross-tenant (no existence leak)
invoice_shortcut_already_paid,             // 409. Invoice fully paid / no balance due
invoice_shortcut_not_payable,              // 422. Invoice status is not payable
invoice_shortcut_no_evidence,              // 422. Invoice has no linked document evidence
invoice_shortcut_source_account_unresolved // 422. No AP account / multiple without a default

// Audit
audit_event_not_found, audit_proof_invalid, audit_anchor_not_yet_published

// Infrastructure
dependency_unavailable, internal_server_error, rate_limit_exceeded
```

The legacy `execution_*` codes remain shipped and equivalent to their `agent_*` aliases for the duration of the v0.3 transition. New code raises the `agent_*` codes.

## 5. Idempotency

### 5.1 The Two Rules

Every write endpoint is either naturally idempotent or accepts an `Idempotency-Key` header. Naturally idempotent means the same inputs always produce the same result regardless of how many times they are submitted. Examples: `/raw/ingest` (content-addressed by sha256), `/wiki/annotate` (derived from target + correction hash), `/ledger/normalize` (derived from raw_artifact id + parser version).

Explicit idempotency keys are scoped to the tenant and TTL'd at 24 hours in Redis. A request with a key matching a completed request returns the stored response. A request with a key matching an in-flight request gets a 409.

### 5.2 Webhooks

Webhook handlers are idempotent by the provider's event_id. Plaid's `webhook_id`, Stripe's `id`, Alchemy's `id` field. The first handler to insert the event_id wins; subsequent retries return 202 with the stored result.

### 5.3 Smart Contract Transactions

Smart contract writes are idempotent by the nonce of the signing account and the canonical transaction hash. The audit publisher tracks the last published root per tenant and refuses to re-publish the same root.

## 6. Pre-Execution Gate

The pre-execution gate is the deterministic safety mechanism that runs before any action that touches money. No PaymentIntent execution path may bypass it. The gate produces a `PolicyDecision` that downstream layers consume as proof.

### 6.1 What It Covers

Any of the following must pass through the gate:

- Outbound payment (ACH, wire, card, on-chain)
- Inbound transfer initiation
- Account opening, closing, or limit change
- Any write to the tenant's BrainSmartAccount
- Any agent action with a money-movement side effect

### 6.2 The 13 Deterministic Checks + 4 Hardening Additions

The gate runs **13 numbered checks** in order, interleaved with **4 hardening
sub-checks** (`1.5`, `7.5`, `9.5`, `11.5`) added across the v0.4 hardening wave.
17 entries total. The canonical happy path is the 13 numbered checks; the four
additions are additive and several record `not_applicable` when their loader is
not wired (see §6.2.1), so a minimal caller still sees the canonical 13. Failure
short-circuits and produces a `payment_intent_gate_failed` error with the failing
check identified. The full check index recorded on a fully-wired passing run is
`1, 1.5, 2, 3, 4, 5, 6, 7, 7.5, 8, 9, 9.5, 10, 11, 11.5, 12, 13`.

1. **Agent identity verified.** JWT principal_type=agent, agent_id matches an active row in `agents`.
   1.5. **Agent behavior pinned.** The agent's runtime `behaviorHash` matches the registered hash; a mismatch rejects regardless of all other checks.
2. **Agent authorization.** Scope set includes the verb required for this action (`payment_intent:propose`, etc.).
3. **Action allowed.** Policy DSL `applies_to` matches the action kind.
4. **Source account allowed.** `account_id` belongs to the tenant and is in `active` status.
5. **Counterparty allowed.** `counterparty_id` exists in `ledger_counterparties`, not on a sanctions list.
6. **Counterparty verified.** `verified_status` ≠ `unverified` for amounts above the policy-defined threshold.
7. **Amount within policy limit.** `amount.lte` rule from active policy holds.
   7.5. **Ledger state bound (H-08).** A `ledger_snapshot_hash` of the source account + counterparty state is computed and pinned onto the decision + audit-before event. A tamper-evident record of what the action moved against.
8. **Available balance sufficient.** `ledger_accounts.available_balance` ≥ amount + reserved.
9. **Required evidence present.** Policy clause `evidence_required` (e.g. invoice attached for B2B AP) holds. The referenced evidence rows exist and are of the right kind.
   9.5. **Evidence supports the action (H-21).** Semantic validation: the evidence's amount, counterparty, currency, and freshness actually match the PaymentIntent. Not just that _some_ evidence is attached. (A $500 invoice on a $50k payment fails here.)
10. **Approval requirement determined.** Policy decision is one of `allow` (no approval), `confirm` (approval needed), `reject` (refuse).
11. **Approval granted when required.** If `confirm`, all `required_approvers` have signed.
    11.5. **No duplicate payment (H-22).** Hard reject. Even with a valid approval. If any duplicate-payment rule fires (invoice already paid, obligation already settled, same vendor+amount recently executed, evidence artifact reused, destination instructions changed). "Brain will not pay an invoice twice" as a gate property.
12. **PolicyDecision row created.** Inserted with `policy_decision_id` returned to caller.
13. **Audit event before execution attempt** _and_ **audit event after execution result.** Both rows are mandatory; the post-execution audit captures success or failure, with rail receipt where applicable. The audit-before event persists the full check trace (H-07) so the Proof API can reproduce it.

Steps 12 and 13 are non-skippable even if every other check passes. The audit-before/audit-after pair is what makes execution forensically reconstructible. And is what the Proof API (`GET /v1/proof/{action_id}`) assembles into a verifiable artifact.

#### 6.2.1 The four hardening additions

Each maps 1:1 to a check in `shared/src/gate/gate.ts`. When the addition's loader
is not wired by the caller, it records `not_applicable` (a passing row) rather
than failing. So the happy path stays the canonical 13. The exception is `7.5`,
which has no loader and always runs.

| Index  | Name (in `gate.ts`)        | Guards against                                                                   | When its loader is not wired                                                                                                                                                           |
| ------ | -------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1.5`  | `agent_behavior_pinned`    | A swapped model/prompt/tools behind a registered agent identity.                 | No `resolveTenantFlags` ⇒ no check row (legacy). With it + tenant opted out ⇒ `not_applicable`. With `require_behavior_hash=true` (P0.1) a missing/mismatched hash is a **hard fail**. |
| `7.5`  | `ledger_state_bound`       | A silent change to source-account / counterparty state between decide & execute. | Always runs (no loader); pins a `ledger_snapshot_hash` onto the decision + audit-before.                                                                                               |
| `9.5`  | `evidence_supports_action` | Evidence that exists but doesn't support the action (wrong amount/CP/currency).  | No `resolveEvidence` ⇒ `not_applicable`.                                                                                                                                               |
| `11.5` | `no_duplicate_payment`     | Paying an invoice/obligation twice, reused evidence, changed destination.        | No `detectDuplicates` ⇒ `not_applicable`. A collision is a **hard reject even with approval**.                                                                                         |

### 6.3 Where the Gate Lives

The gate is a shared primitive in `shared/src/gate/` (the `@brain/shared` package), called by:

- `POST /payment-intents/{id}/execute`
- `POST /actions/{id}/execute`

Both routes reach it through `PaymentIntentService.execute`. Calling sites are enumerated in code, and `scripts/check-gate-bypass.mjs` (run by `pnpm run lint`) fails CI if any rail dispatch or transition to `executed` appears outside `PaymentIntentService`.

### 6.4 What the Gate Must Not Do

- Read from the Wiki. Wiki text is not authoritative.
- Defer to LLM judgment. Every check is deterministic.
- Mutate Ledger or execute the action. The gate produces a decision; execution is downstream.
- Catch and continue. Any failed check is a hard stop.

### 6.5 Shadow-by-default and promotion readiness

Money-moving agents are **shadow-by-default**: until an operator explicitly
promotes an agent, every financial proposal it makes terminates as
`shadow_completed`. Fully gated, evidenced, and audited, but no rail is
dispatched. Promotion is the single dangerous moment, so it is gated:

> **An agent cannot be promoted from shadow to live without all
> promotion-readiness checks green.** The live-agent allowlist lives in one file
> (`services/agent-router/src/promotion-config.ts`). `scripts/check-promotion-readiness.mjs`
> is run automatically in CI on diffs to that file, and the PR is blocked on any
> red row.

The readiness checks (H-24) include: the execution outbox table exists + is
RLS-armed; gate checks 9.5 (evidence semantics) and 11.5 (duplicate payment) are
active; a typed rail-receipt schema exists for every rail on the agent's
allowlist; the replay-investigation endpoint is reachable; halt-category and
per-agent adversarial test suites exist; and the agent's on-chain behavior hash

- session-key grants are registered (the last two are attested out-of-band since
  they require a registry / DB read).

### 6.6 Planned compliance gates (not yet implemented)

KYC/KYB/sanctions/velocity/rail-allowlist belong in the §6 sequence so the shape
is correct from day one, even while the providers are mocked. They are
**planned gate additions**. Documented here with the check index they will
occupy so the gate trace shape is stable. Like the other additions, each records
`not_applicable` until its provider loader is wired (mirrors §6.2.1).

| Planned index | Name                       | What it checks                                                                            | Status                                                                 |
| ------------- | -------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `2.7`         | `tenant_kyb_verified`      | The tenant's KYB status is `verified` (business onboarding complete).                     | Planned. Provider mocked.                                              |
| `4.5`         | `source_account_kyc`       | The source account's owner KYC status is cleared.                                         | Planned. Provider mocked.                                              |
| `5`           | `counterparty_allowed`     | Counterparty not sanctioned. **already live** via Chainalysis at check 5.                | **Implemented** (documented here explicitly).                          |
| `4.6`         | `rail_allowlisted`         | The action's rail is on the tenant's allowlist (e.g. ACH-only tenants can't go on-chain). | Planned. Tenant rail-allowlist config TBD.                             |
| `11.6`        | `velocity_within_envelope` | Cumulative spend/count to this counterparty within a rolling window is under the cap.     | Planned. Builds on the existing spend/tx-count window reads (§Policy). |

These slot in without renumbering the canonical 13: KYB after agent auth (2.7),
KYC + rail-allowlist after source-account (4.5 / 4.6), velocity after the
duplicate guard (11.6). Sanctions is check 5 today. No implementation in this
pass. This section fixes the contract so the loaders can land additively.

## 7. Observability

### 7.1 Logs

Structured JSON. Every log line includes: `timestamp`, `level`, `service`, `tenant_id`, `request_id`, `trace_id`, `message`. Additional fields per log site. No personally identifiable information in log bodies, ever. Sensitive fields are hashed or redacted at the logging boundary.

Log levels:

- **error**: something broke, page someone
- **warn**: something unexpected but handled
- **info**: business-meaningful events (proposal created, payment executed)
- **debug**: developer detail, off in production

### 7.2 Metrics

Datadog custom metrics. Standard RED metrics (Rate, Errors, Duration) emitted automatically by the API gateway per endpoint. Service-specific metrics per the inventory in `services/*/metrics.ts`.

Required metrics at MVP:

- `brain.api.request.count` (tagged by endpoint, status_code, tenant_id)
- `brain.api.request.duration` (same tags)
- `brain.ledger.write.count` (tagged by entity, source, extracted | annotated | reconciled | agent_contributed)
- `brain.ledger.reconciliation.match.count` (tagged by match_type, status)
- `brain.wiki.question.latency` (tagged by model, query_count)
- `brain.wiki.question.cost` (LLM token cost per question)
- `brain.policy.evaluation.duration` (tagged by decision)
- `brain.gate.check.failure.count` (tagged by check_index 1..13, action_kind), the pre-execution gate
- `brain.payment_intent.count` (tagged by status, agent_id, rail)
- `brain.audit.anchor.lag` (time since last anchor publication)

### 7.3 Traces

OpenTelemetry across all services. Every request gets a trace_id. Cross-service calls propagate the context. Spans named `{service}.{operation}`. LLM calls are their own spans with model and token counts as attributes. Pre-execution gate runs as a single span with one child span per check.

### 7.4 Alerts

Only two severity levels: **page** and **ticket**.

Page conditions:

- 5xx rate above 1% over 5 minutes on any public endpoint
- Audit anchor lag exceeds 2 hours
- Policy evaluation error rate above 0.1%
- Pre-execution gate failure rate spikes 10× above 7-day baseline
- Any smart contract transaction reverts
- p99 request latency above 5s on any endpoint

Ticket conditions are everything else worth noticing. Ticket thresholds tuned monthly; page thresholds tuned only after post-mortem.

## 8. Testing

### 8.1 The Coverage Contract

- **Unit tests**: 80% line coverage on every service. Enforced in CI.
- **Integration tests**: Every endpoint in the OpenAPI spec has at least one happy-path integration test and one error-path test.
- **Property tests**: The policy evaluator, the Merkle anchor builder, the Ledger reconciliation matcher, the pre-execution gate, and the four smart contracts have property-based tests. The TypeScript ones use fast-check; the contracts use Foundry invariants.
- **E2E tests**: The three Series A proof-points (six-layer end-to-end, Ledger compounding, external agent via MCP) each have a dedicated E2E test suite running against staging.

### 8.2 Deterministic Tests for Non-Deterministic Components

`/wiki/question` is tested via a recorded-prompt harness: canonical question, frozen Ledger + Wiki state, recorded LLM response, assertion on structured output. New LLM behaviors require updating the frozen response, with a PR review that explicitly approves the change.

Agent reasoning is tested similarly. The three MVP agents have 20+ canonical scenarios each, recorded and replayed.

### 8.3 Smart Contract Testing

Foundry for everything. Every contract has:

- Unit tests per function
- Fuzz tests on every external function with non-trivial input
- Invariant tests for system properties (e.g., "a revoked session key cannot execute", "registered agents have scope_hash matching stored scope")
- Gas benchmarks in a fixture file, compared against a baseline on every PR

External audit required before mainnet deployment. Budget: 80k per audit, probably two rounds (mid-build and pre-deploy).

### 8.4 Invariants

Invariants enforced as test suites (lands alongside Phase 6 of the v0.3 refactor):

- Every transaction belongs to an account.
- Every transaction has at least one source_id or evidence_id.
- Every transaction has a valid direction.
- Every obligation has a valid status.
- Every PaymentIntent has a `policy_decision_id` before execution.
- Every executed PaymentIntent has an audit trail with both before-execute and after-execute events.
- Every agent action has an `agent_id`.
- Every material state transition creates an `audit_event`.
- Every wiki page is regenerable from Ledger + Raw.
- No payment can execute from Wiki data alone.
- Agents can recommend from memory, but execute only from verified Ledger state.
- Policy evaluation reads from Ledger state, not Wiki text.
- Raw source payloads are preserved unchanged.
- Ledger records are derived from Raw evidence or external source ids.
- Audit events cannot be edited after creation.

## 9. State Machines

Five critical entities have explicit state machines. Every transition must be enforced in code and emit an audit event.

### 9.1 Proposal (Non-Financial Agent Action)

```
        ┌──────────────────────────────────┐
        v                                  │
    [pending] ──────────────────────> [rejected]
        │                                  ^
        │                                  │
        ├──> [approved] ──> [executed]     │
        │        │               │         │
        │        v               v         │
        │    [rejected]      [failed] ─────┘
        │
        └──> [rejected]   # policy decision returned reject
```

`pending` is only reachable on creation. `approved` is reachable from `pending` when policy decision is `allow` (auto) or all required approvers have signed (`confirm`). `executed` is terminal unless re-processing is triggered by a contract reversion, which creates a new proposal. `rejected` is terminal. `failed` is terminal for this proposal but does not prevent retries via a new proposal.

For financial actions, use **PaymentIntent** (§9.5) instead of Proposal. The two are kept separate so financial state transitions carry distinct invariants (gate must run, evidence must be linked, policy_decision_id must be present).

### 9.2 Execution

```
[dispatched] ──> [in_flight] ──> [completed]
                      │
                      └──────────> [failed]
```

Transitions are driven by rail-specific callbacks (ACH return file, ERP write confirmation, on-chain tx receipt). Timeouts are per-rail and documented in `services/execution/src/rails/*.ts`.

### 9.3 Policy

```
[draft] ──> [pending_signatures] ──> [active] ──> [deactivated]
   │                 │
   v                 v
[cancelled]     [expired]
```

Only one policy per tenant is active at a time. Activating version N+1 deactivates version N atomically.

### 9.4 Agent Registration

```
[pending_onchain] ──> [active] ──> [revoked]
       │
       v
   [failed]
```

An agent is not usable until the on-chain registration transaction confirms. Between submission and confirmation, the agent is in `pending_onchain` and rejects all proposal attempts.

### 9.5 PaymentIntent (V0.2)

```
[proposed] ──> [pending_approval] ──> [approved] ──> [executed]
    │              │                       │              │
    │              │                       │              v
    │              │                       │         [failed]
    │              │                       v
    │              │                  [rejected]
    │              v
    │         [rejected]
    v
[cancelled]
```

`proposed` is only reachable on creation by an agent with `payment_intent:propose`. Transition to `pending_approval` happens on PolicyDecision = `confirm`; transition to `approved` happens on PolicyDecision = `allow` or after all approvers have signed in `pending_approval`. `executed` is reachable only from `approved` and only via the §6 pre-execution gate. `cancelled` is reachable from `proposed` only (the proposing agent or its tenant root user can cancel an unprocessed intent). `rejected` is terminal. `failed` is terminal but does not bar retries via a new PaymentIntent.

Every transition emits an audit event. The `executed → failed` edge specifically carries the rail receipt (or error trace) in the audit `outputs` field.

## 10. Dependencies

Each external dependency has a one-page contract. Summaries of the six MVP dependencies:

### 10.1 Plaid

- Endpoints used: `/accounts/balance/get`, `/transactions/sync`, `/transfer/create`, `/transfer/get`
- Rate limit: 600 rpm per institution
- Retry policy: exponential backoff, max 3 retries, then escalate
- Fallback: none at MVP. Multi-aggregator strategy is Post-Series A.
- Credentials: rotated quarterly, stored in Azure Key Vault
- Webhook idempotency: by `webhook_id`

### 10.2 NetSuite

- Endpoints: SuiteTalk REST for GL, AP, vendors
- Rate limit: 5 concurrent requests per account
- Retry policy: 5 retries with jitter, deadline 30s
- Fallback: queue writes locally and retry for 24h before escalating
- Credentials: OAuth 2.0, refreshed 7 days before expiry
- Webhook idempotency: NetSuite does not push; we poll on a 5-minute interval

### 10.3 Alchemy (Base L2)

- Endpoints used: standard `eth_*` RPC, `getLogs`, `getReceipt`
- Rate limit: 330 compute units per second on growth tier
- Retry policy: 3 retries, fall back to public Base RPC
- Credentials: API key in Key Vault
- Node reliability target: 99.9% uptime, 100ms p50 response

### 10.4 Chainalysis

- Endpoints: address screening, sanctions check
- Rate limit: 100 rpm
- Retry policy: 2 retries, then fail closed (block the transaction)
- Fallback: none. Fail-closed is the right posture for sanctions.
- Used by: §6 pre-execution gate (counterparty verified check), `ledger_counterparties.risk_level` population.

### 10.5 OpenAI + Anthropic

- Primary: Claude for reasoning and extraction
- Secondary: OpenAI for embeddings and for fallback when Claude is degraded
- Retry policy: 2 retries with model swap on the second attempt
- Budget enforcement: per-tenant daily cap, 429 when exceeded

### 10.6 Base L2 (Direct)

- Submitted transactions only, not RPC reads
- Gas policy: priority fee at 20% above Base median, capped at $0.50/tx equivalent
- Signing: publisher account is a Safe multi-sig, 2-of-3

## 11. Deployment

### 11.1 Environments

- **Local**: Docker Compose, real Postgres + Redis + LocalStack for Azure Blob equivalent
- **Staging**: Full Azure stack, hits Plaid sandbox, Alchemy sandbox, Base Sepolia
- **Production**: Azure East US primary, Azure West US 3 backup, Base mainnet

### 11.2 Pipeline

GitHub Actions. On PR: lint, unit, contract compile, property tests. On merge to main: integration tests, build images, push to Azure Container Registry, deploy to staging, E2E tests, manual promote to production.

### 11.3 Rollback

Every service runs N and N-1 in parallel during a rolling deploy. Traffic is shifted via Azure Container Apps revision weights. Rollback is one command: `az containerapp revision set-active --revision N-1`. Database migrations are always forward-compatible. Never ship a migration that requires a code version to be running.

### 11.4 Secrets

Azure Key Vault. Managed identities for service-to-vault access. No secrets in environment variables, config files, or application code. CI reads secrets from Key Vault at deploy time. Rotation schedule documented in `infra/secrets.md`.

### 11.5 Data Migrations

Four rules:

- Migrations are backward compatible for at least one version.
- Migrations that rewrite large tables run async and report progress.
- Migrations that touch tenant data require a dry-run report reviewed before execution.
- **Ledger migrations require a pre-cutover diff report.** The runner outputs row counts before and after, plus a sample of changed rows, signed by the engineer applying the migration. Stored in `audit_events` for the duration of the retention period.

Migrations are authored in `services/*/migrations/` and executed by the `tools/migrate` binary.

## 12. Security

### 12.1 SOC 2 Readiness

SOC 2 Type 1 is a Month 12 deliverable. Every standard in this document exists partly to make that audit pass. The controls that matter most:

- **Access control**: SSO via Azure AD with hardware MFA required for engineers
- **Change management**: PR review required, CI gates enforced, deploy approval trail
- **Incident response**: runbook in `docs/incident-response.md`, quarterly game days
- **Data protection**: encryption at rest (Azure-managed keys), encryption in transit (TLS 1.3), PII redaction at logging boundary
- **Vendor management**: each dependency has the one-page contract referenced in section 10

### 12.2 Threat Model Summary

Documented in `docs/threat-model.md`. Primary threats:

- Cross-tenant data leak via application bug (mitigated by RLS)
- Agent credential compromise (mitigated by short-lived JWTs and on-chain revocation for external agents)
- Malicious policy injection (mitigated by EIP-712 signature requirement and content-hash verification)
- Smart contract exploit (mitigated by external audit and bug bounty pre-mainnet)
- LLM prompt injection (mitigated by structured input validation, Ledger-grounded retrieval, and never executing unverified LLM output)
- **Wiki-as-truth attack** (v0.2): a malicious agent or compromised ingestion path attempts to seed Wiki text that influences a downstream decision. Mitigated by §6 (Policy never reads Wiki) and §1 principle 5 (deterministic gate).

### 12.3 Secrets in Code

Prohibited. Pre-commit hook scans for common patterns. CI scans every PR. Any secret accidentally committed triggers immediate rotation and a security incident review.

## 13. Code Style

### 13.1 TypeScript

- Strict mode. No `any`. No `@ts-ignore` without a comment explaining why.
- ESLint config in repo root. Enforced in CI.
- Prettier for formatting. Enforced in CI.
- Every public function has JSDoc with parameters and return.
- Naming: camelCase for variables and functions, PascalCase for types and classes, SCREAMING_CASE for constants.

### 13.2 Python

- Black for formatting. Ruff for linting. Both enforced in CI.
- Type hints on every public function. `mypy --strict` in CI.
- Python 3.12+. Use new features freely.

### 13.3 Solidity

- Solidity 0.8.24 or later.
- OpenZeppelin where a well-tested primitive exists. Write custom only when justified.
- Every function has a NatSpec comment.
- Every function emits an event for every state change.
- No upgradable contracts in MVP. Immutable after audit.

### 13.4 Commits and PRs

- Commit messages: imperative mood, present tense, max 72 chars on the subject line.
- PR descriptions: what changed, why, and how to test. Link to the tracking issue.
- No merge without at least one review from a human engineer, regardless of whether an AI assistant wrote the code.
- AI-generated PRs are labeled `ai-assisted` for tracking.

## 14. How AI Coding Assistants Should Use This Document

Two rules.

**Rule one**: when the spec and this document disagree with what feels natural, follow the spec and this document. They are the source of truth. Your priors about "how APIs usually look" are not.

**Rule two**: when something is underspecified, stop and ask. Underspecified means: the spec does not constrain the decision, this document does not cover it, and the decision has cross-cutting implications. Do not guess. Leave a clearly marked TODO with a question, and surface it for human review.

Specifically for Claude Code: reference `Brain_API_Specification.yaml` for every endpoint implementation. Reference this document for auth, errors, idempotency, observability, testing, and deployment conventions. Reference `Brain_MVP_Architecture.md` only when you need context on why a decision was made.

**v0.2 rule three (new)**: when an existing service or contract appears to violate the six-layer boundary (e.g. an agent reads Wiki text to decide a payment, or a Policy evaluator queries Wiki entities), STOP and surface it. Do not "fix" it by reproducing the violation in new code. The boundaries are non-negotiable.

## 15. What This Document Does Not Cover

This is v0.2.0. It will grow. Topics explicitly deferred to later revisions:

- SLA and SLO commitments to external customers (comes with the commercial launch)
- Multi-region active-active (Post-Series A)
- Customer-managed encryption keys (enterprise tier post-MVP)
- Bug bounty program details (pre-mainnet, not yet)
- On-call rotation and runbooks (Month 4 onward, when there is something to be on-call for)

When those become relevant, this document updates. Every update is a PR with review.

End of v0.2.0. Maintained by the engineering lead. Last material revision logged in git history.

| Class            | HTTP | When                                                                    |
| ---------------- | ---- | ----------------------------------------------------------------------- |
| Input validation | 400  | Request body or params fail schema validation                           |
| Missing auth     | 401  | No bearer token or token invalid                                        |
| Forbidden        | 403  | Authenticated but scope or tenant mismatch                              |
| Not found        | 404  | Resource does not exist or is tombstoned                                |
| Conflict         | 409  | Illegal state transition, duplicate idempotency key with different body |
| Too large        | 413  | Request body exceeds the 50MB ingestion cap or similar                  |
| Rate limited     | 429  | Exceeded per-tenant rate budget                                         |
| Server error     | 500  | Unexpected exception. Always accompanied by pager alert                 |
| Unavailable      | 503  | Dependency down, circuit breaker open, graceful degradation             |
