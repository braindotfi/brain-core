# Brain Engineering Standards

Brain Finance Inc. | v0.1.0 MVP

This document defines the conventions every engineer, contractor, and AI coding assistant follows when building Brain. It is the decision log that keeps the codebase consistent and the production-posture credible.

Read alongside: Brain_API_Specification.yaml (the OpenAPI contract) and Brain_MVP_Architecture.md (the protocol blueprint).

## 1. Non-negotiable principles

Four principles override every implementation preference. If a trade-off question comes up and these are on one side, they win.

Provenance on everything. Every derived fact in the Wiki carries provenance, confidence, and a pointer to source evidence. No exceptions. A Wiki row without those three fields is a bug, regardless of how convenient it would be to skip them.

Tenant isolation at the storage layer, not the query layer. Row-level security on every Postgres table. Per-tenant path prefixes in Azure Blob. A bug in application code must not be able to leak cross-tenant data. Shared-query-with-filter is not an acceptable pattern for tenant-scoped data.

Idempotency by default on writes. Every write endpoint accepts an idempotency key or derives one from content. Retries are safe. Duplicate events are detected. This is required for webhook reliability and for agent retry behavior.

Audit everything that matters. Every API call, policy evaluation, agent action, and state transition produces an audit event. The audit log is append-only and Merkle-chained. If it is not in the log, it did not happen.

## 2. Repository layout

One monorepo. Language-specific workspaces inside. Workspaces publish typed clients to each other.

brain/
├── services/
│   ├── api/              # TypeScript. Public HTTP API gateway.
│   ├── raw/              # TypeScript. Ingestion workers.
│   ├── wiki/             # TypeScript. Wiki read/write. SQL + pgvector.
│   ├── policy/           # TypeScript. Rule VM and evaluator.
│   ├── execution/        # TypeScript. Proposal + execution state machine.
│   ├── audit/            # TypeScript. Append-only log + Merkle anchor publisher.
│   └── agents/           # Python. Extractors, reasoners, the three MVP agents.
├── contracts/            # Solidity + Foundry. The four smart contracts.
├── infra/                # Terraform. Azure resource definitions.
├── schemas/              # JSON Schemas per Wiki entity/relation kind.
├── clients/              # Generated typed clients for each service.
├── tests/
│   ├── unit/             # Co-located with source in each workspace.
│   ├── integration/      # Cross-service. Spin up containers, run against real deps.
│   └── e2e/              # Full-stack against staging environment.
└── tools/                # Dev scripts, migration runners, backfill utilities.

Every service owns its database schema. Cross-service reads go through the owning service's API, never direct database access. This is the rule that preserves the option to extract services later.

## 3. Authentication and authorization

### 3.1 The auth model

Bearer JWT on every endpoint except three: /raw/webhooks/{provider} (HMAC-signed), /audit/verify (public, pure function), and the root health check.

JWT payload:

{
  "iss": "https://auth.brain.fi",
  "sub": "user_01HQ7K3..." or "agent_01HQ7K3...",
  "tenant_id": "tnt_01HQ7K3...",
  "principal_type": "user" | "agent" | "api_partner",
  "scopes": ["raw:write", "wiki:read", "policy:sign", ...],
  "exp": 1745000000,
  "jti": "token_01HQ7K3..."
}

Tokens are short-lived (15 minutes) and refreshed via a standard refresh-token flow. Refresh tokens rotate on every use. Revoked jti values are cached in Redis for the remainder of their original expiry window.

### 3.2 Scopes

Scopes are {layer}:{verb} strings. The verb is one of read, write, admin. Admin is only held by the tenant root user and is required for signing policies and registering agents.

External agents (principal_type=agent, registered in BrainMCPAgentRegistry) are granted scopes explicitly by the tenant at registration time via EIP-712 signature. The three scopes an external agent can hold are wiki:read, raw:write (for agent contributions), and execution:propose. An agent granted raw:write can push artifacts into the Raw layer using source_type=agent_contributed. These artifacts flow through the extraction pipeline, but any derived Wiki entities carry provenance=agent_contributed and start at a confidence ceiling of 0.5 regardless of extractor certainty. Promotion above 0.5 requires independent corroboration or explicit tenant approval via /wiki/annotate. This governance boundary is enforced in the Wiki write path, not just documented here, and is non-negotiable.

Scope to endpoint mapping is enforced in the API gateway, not in individual services. Services trust the scopes in the JWT but re-verify tenant_id equality on every query.

### 3.3 Agent identities

Every agent, internal or external, has its own JWT with principal_type=agent. The agent_id in the sub claim must match a row in the Agent table. External agents registered via /execution/agents/register receive their initial JWT immediately after the on-chain registration transaction confirms.

### 3.4 HMAC webhooks

Each provider (Plaid, Stripe, NetSuite, Alchemy) has a provider-specific HMAC signature scheme. The X-Brain-Signature header is verified before the request body is parsed. Failed verification returns 401 and logs a security event. No exceptions.

## 4. Error handling

### 4.1 The error envelope

Every non-2xx response body conforms to this shape:

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

code is a stable machine-readable string. It never changes once shipped. Code strings follow {domain}_{condition} convention. See section 4.3 for the registry.

### 4.2 Status code mapping

Never return a 200 with an error in the body. HTTP status and error envelope are both mandatory and must agree.

### 4.3 Error code registry

Codes are defined in services/api/src/errors.ts and regenerated into the OpenAPI spec. Adding a new code requires a PR that updates both. The registry:

// Auth
auth_token_missing, auth_token_invalid, auth_token_expired,
auth_scope_insufficient, auth_tenant_mismatch

// Validation
request_body_invalid, request_params_invalid, request_too_large

// Raw
raw_artifact_not_found, raw_artifact_tombstoned, raw_source_unsupported,
raw_webhook_signature_invalid

// Wiki
wiki_entity_not_found, wiki_schema_validation_failed,
wiki_temporal_range_invalid, wiki_question_timeout

// Policy
policy_not_found, policy_rule_invalid, policy_quorum_not_met,
policy_signature_invalid, policy_version_mismatch

// Execution
execution_proposal_not_found, execution_proposal_invalid_state,
execution_rail_unavailable, execution_idempotency_conflict,
execution_agent_not_registered

// Audit
audit_event_not_found, audit_proof_invalid, audit_anchor_not_yet_published

// Infrastructure
dependency_unavailable, internal_server_error, rate_limit_exceeded

## 5. Idempotency

### 5.1 The two rules

Every write endpoint is either naturally idempotent or accepts an Idempotency-Key header. Naturally idempotent means the same inputs always produce the same result regardless of how many times they are submitted. Examples: /raw/ingest (content-addressed by sha256), /wiki/annotate (derived from target + correction hash).

Explicit idempotency keys are scoped to the tenant and TTL'd at 24 hours in Redis. A request with a key matching a completed request returns the stored response. A request with a key matching an in-flight request gets a 409.

### 5.2 Webhooks

Webhook handlers are idempotent by the provider's event_id. Plaid's webhook_id, Stripe's id, Alchemy's id field. The first handler to insert the event_id wins; subsequent retries return 202 with the stored result.

### 5.3 Smart contract transactions

Smart contract writes are idempotent by the nonce of the signing account and the canonical transaction hash. The audit publisher tracks the last published root per tenant and refuses to re-publish the same root.

## 6. Observability

### 6.1 Logs

Structured JSON. Every log line includes: timestamp, level, service, tenant_id, request_id, trace_id, message. Additional fields per log site. No personally identifiable information in log bodies, ever. Sensitive fields are hashed or redacted at the logging boundary.

Log levels:

error: something broke, page someone

warn: something unexpected but handled

info: business-meaningful events (proposal created, payment executed)

debug: developer detail, off in production

### 6.2 Metrics

Datadog custom metrics. Standard RED metrics (Rate, Errors, Duration) emitted automatically by the API gateway per endpoint. Service-specific metrics per the inventory in services/*/metrics.ts.

Required metrics at MVP:

brain.api.request.count (tagged by endpoint, status_code, tenant_id)

brain.api.request.duration (same tags)

brain.wiki.question.latency (tagged by model, query_count)

brain.wiki.question.cost (LLM token cost per question)

brain.policy.evaluation.duration (tagged by decision)

brain.execution.proposal.count (tagged by status, agent_type, rail)

brain.audit.anchor.lag (time since last anchor publication)

### 6.3 Traces

OpenTelemetry across all services. Every request gets a trace_id. Cross-service calls propagate the context. Spans named {service}.{operation}. LLM calls are their own spans with model and token counts as attributes.

### 6.4 Alerts

Only two severity levels: page and ticket.

Page conditions:

5xx rate above 1% over 5 minutes on any public endpoint

Audit anchor lag exceeds 2 hours

Policy evaluation error rate above 0.1%

Any smart contract transaction reverts

p99 request latency above 5s on any endpoint

Ticket conditions are everything else worth noticing. Ticket thresholds tuned monthly; page thresholds tuned only after post-mortem.

## 7. Testing

### 7.1 The coverage contract

Unit tests: 80% line coverage on every service. Enforced in CI.

Integration tests: Every endpoint in the OpenAPI spec has at least one happy-path integration test and one error-path test.

Property tests: The policy evaluator, the Merkle anchor builder, and the four smart contracts have property-based tests. The policy evaluator uses fast-check; the contracts use Foundry invariants.

E2E tests: The three Series A proof-points (five-layer end-to-end, Wiki compounding, external agent via MCP) each have a dedicated E2E test suite running against staging.

### 7.2 Deterministic tests for non-deterministic components

/wiki/question is tested via a recorded-prompt harness: canonical question, frozen Wiki state, recorded LLM response, assertion on structured output. New LLM behaviors require updating the frozen response, with a PR review that explicitly approves the change.

Agent reasoning is tested similarly. The three MVP agents have 20+ canonical scenarios each, recorded and replayed.

### 7.3 Smart contract testing

Foundry for everything. Every contract has:

Unit tests per function

Fuzz tests on every external function with non-trivial input

Invariant tests for system properties (e.g., "a revoked session key cannot execute", "registered agents have scope_hash matching stored scope")

Gas benchmarks in a fixture file, compared against a baseline on every PR

External audit required before mainnet deployment. Budget: 80k per audit, probably two rounds (mid-build and pre-deploy).

## 8. State machines

Four critical entities have explicit state machines. Every transition must be enforced in code and emit an audit event.

### 8.1 Proposal

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

pending is only reachable on creation.

approved is reachable from pending when policy decision is allow (auto) or all required approvers have signed (confirm).

executed is terminal unless re-processing is triggered by a contract reversion, which creates a new proposal.

rejected is terminal.

failed is terminal for this proposal but does not prevent retries via a new proposal.

### 8.2 Execution

    [dispatched] ──> [in_flight] ──> [completed]
                          │
                          └──────────> [failed]

Transitions are driven by rail-specific callbacks (ACH return file, ERP write confirmation, on-chain tx receipt). Timeouts are per-rail and documented in services/execution/rails/*.ts.

### 8.3 Policy

    [draft] ──> [pending_signatures] ──> [active] ──> [deactivated]
       │                 │
       v                 v
    [cancelled]     [expired]

Only one policy per tenant is active at a time. Activating version N+1 deactivates version N atomically.

### 8.4 Agent registration

    [pending_onchain] ──> [active] ──> [revoked]
           │
           v
       [failed]

An agent is not usable until the on-chain registration transaction confirms. Between submission and confirmation, the agent is in pending_onchain and rejects all proposal attempts.

## 9. Dependencies

Each external dependency has a one-page contract. Summaries of the six MVP dependencies:

### Plaid

Endpoints used: /accounts/balance/get, /transactions/sync, /transfer/create, /transfer/get

Rate limit: 600 rpm per institution

Retry policy: exponential backoff, max 3 retries, then escalate

Fallback: none at MVP. Multi-aggregator strategy is Post-Series A.

Credentials: rotated quarterly, stored in Azure Key Vault

Webhook idempotency: by webhook_id

### NetSuite

Endpoints: SuiteTalk REST for GL, AP, vendors

Rate limit: 5 concurrent requests per account

Retry policy: 5 retries with jitter, deadline 30s

Fallback: queue writes locally and retry for 24h before escalating

Credentials: OAuth 2.0, refreshed 7 days before expiry

Webhook idempotency: NetSuite does not push; we poll on a 5-minute interval

### Alchemy (Base L2)

Endpoints used: standard eth_* RPC, getLogs, getReceipt

Rate limit: 330 compute units per second on growth tier

Retry policy: 3 retries, fall back to public Base RPC

Credentials: API key in Key Vault

Node reliability target: 99.9% uptime, 100ms p50 response

### Chainalysis

Endpoints: address screening, sanctions check

Rate limit: 100 rpm

Retry policy: 2 retries, then fail closed (block the transaction)

Fallback: none. Fail-closed is the right posture for sanctions.

### OpenAI + Anthropic

Primary: Claude for reasoning and extraction

Secondary: OpenAI for embeddings and for fallback when Claude is degraded

Retry policy: 2 retries with model swap on the second attempt

Budget enforcement: per-tenant daily cap, 429 when exceeded

### Base L2 (direct)

Submitted transactions only, not RPC reads

Gas policy: priority fee at 20% above Base median, capped at $0.50/tx equivalent

Signing: publisher account is a Safe multi-sig, 2-of-3

## 10. Deployment

### 10.1 Environments

Local: Docker Compose, real Postgres + Redis + LocalStack for Azure Blob equivalent

Staging: Full Azure stack, hits Plaid sandbox, Alchemy sandbox, Base Sepolia

Production: Azure East US primary, Azure West US 3 backup, Base mainnet

### 10.2 Pipeline

GitHub Actions. On PR: lint, unit, contract compile, property tests. On merge to main: integration tests, build images, push to Azure Container Registry, deploy to staging, E2E tests, manual promote to production.

### 10.3 Rollback

Every service runs N and N-1 in parallel during a rolling deploy. Traffic is shifted via Azure Container Apps revision weights. Rollback is one command: az containerapp revision set-active --revision N-1. Database migrations are always forward-compatible. Never ship a migration that requires a code version to be running.

### 10.4 Secrets

Azure Key Vault. Managed identities for service-to-vault access. No secrets in environment variables, config files, or application code. CI reads secrets from Key Vault at deploy time. Rotation schedule documented in infra/secrets.md.

### 10.5 Data migrations

Three rules:

Migrations are backward compatible for at least one version.

Migrations that rewrite large tables run async and report progress.

Migrations that touch tenant data require a dry-run report reviewed before execution.

Migrations are authored in services/*/migrations/ and executed by the tools/migrate binary.

## 11. Security

### 11.1 SOC 2 readiness

SOC 2 Type 1 is a Month 12 deliverable. Every standard in this document exists partly to make that audit pass. The controls that matter most:

Access control: SSO via Azure AD with hardware MFA required for engineers

Change management: PR review required, CI gates enforced, deploy approval trail

Incident response: runbook in docs/incident-response.md, quarterly game days

Data protection: encryption at rest (Azure-managed keys), encryption in transit (TLS 1.3), PII redaction at logging boundary

Vendor management: each dependency has the one-page contract referenced in section 9

### 11.2 Threat model summary

Documented in docs/threat-model.md. Primary threats:

Cross-tenant data leak via application bug (mitigated by RLS)

Agent credential compromise (mitigated by short-lived JWTs and on-chain revocation for external agents)

Malicious policy injection (mitigated by EIP-712 signature requirement and content-hash verification)

Smart contract exploit (mitigated by external audit and bug bounty pre-mainnet)

LLM prompt injection (mitigated by structured input validation and never executing unverified LLM output)

### 11.3 Secrets in code

Prohibited. Pre-commit hook scans for common patterns. CI scans every PR. Any secret accidentally committed triggers immediate rotation and a security incident review.

## 12. Code style

### 12.1 TypeScript

Strict mode. No any. No @ts-ignore without a comment explaining why.

ESLint config in repo root. Enforced in CI.

Prettier for formatting. Enforced in CI.

Every public function has JSDoc with parameters and return.

Naming: camelCase for variables and functions, PascalCase for types and classes, SCREAMING_CASE for constants.

### 12.2 Python

Black for formatting. Ruff for linting. Both enforced in CI.

Type hints on every public function. mypy --strict in CI.

Python 3.12+. Use new features freely.

### 12.3 Solidity

Solidity 0.8.24 or later.

OpenZeppelin where a well-tested primitive exists. Write custom only when justified.

Every function has a NatSpec comment.

Every function emits an event for every state change.

No upgradable contracts in MVP. Immutable after audit.

### 12.4 Commits and PRs

Commit messages: imperative mood, present tense, max 72 chars on the subject line.

PR descriptions: what changed, why, and how to test. Link to the tracking issue.

No merge without at least one review from a human engineer, regardless of whether an AI assistant wrote the code.

AI-generated PRs are labeled ai-assisted for tracking.

## 13. How AI coding assistants should use this document

Two rules.

Rule one: when the spec and this document disagree with what feels natural, follow the spec and this document. They are the source of truth. Your priors about "how APIs usually look" are not.

Rule two: when something is underspecified, stop and ask. Underspecified means: the spec does not constrain the decision, this document does not cover it, and the decision has cross-cutting implications. Do not guess. Leave a clearly marked TODO with a question, and surface it for human review.

Specifically for Claude Code: reference Brain_API_Specification.yaml for every endpoint implementation. Reference this document for auth, errors, idempotency, observability, testing, and deployment conventions. Reference Brain_MVP_Architecture.md only when you need context on why a decision was made.

## 14. What this document does not cover

This is v0.1.0. It will grow. Topics explicitly deferred to later revisions:

SLA and SLO commitments to external customers (comes with the commercial launch)

Multi-region active-active (Post-Series A)

Customer-managed encryption keys (enterprise tier post-MVP)

Bug bounty program details (pre-mainnet, not yet)

On-call rotation and runbooks (Month 4 onward, when there is something to be on-call for)

When those become relevant, this document updates. Every update is a PR with review.

End of v0.1.0. Maintained by the engineering lead. Last material revision logged in git history.

| Class | HTTP | When |
| --- | --- | --- |
| Input validation | 400 | Request body or params fail schema validation |
| Missing auth | 401 | No bearer token or token invalid |
| Forbidden | 403 | Authenticated but scope or tenant mismatch |
| Not found | 404 | Resource does not exist or is tombstoned |
| Conflict | 409 | Illegal state transition, duplicate idempotency key with different body |
| Too large | 413 | Request body exceeds the 50MB ingestion cap or similar |
| Rate limited | 429 | Exceeded per-tenant rate budget |
| Server error | 500 | Unexpected exception. Always accompanied by pager alert |
| Unavailable | 503 | Dependency down, circuit breaker open, graceful degradation |
