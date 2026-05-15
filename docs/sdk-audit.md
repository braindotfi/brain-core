# `@brain/sdk` documentation audit

Audit of the public docs at <https://docs.brain.fi> as the canonical spec for the
SDK and HTTP surface, performed against the local artifacts in this repo:

- `Brain_API_Specification.yaml` (OpenAPI v0.2.0)
- `Brain_Engineering_Standards.md` v0.2.0 (§4 error registry, §6 gate)
- `Brain_MVP_Architecture.md` v0.3
- `services/api/src/shared/errors.ts` (canonical TS error registry)

Audit run: 2026-05-15. Source of truth: the published docs. Where the docs and
local artifacts disagree, the docs win and the local artifacts must change.

This is Phase 1 of the `@brain/sdk` scaffold. No code is being written until the
findings here are approved.

---

## 1. SDK method registry

Every public SDK method/expression observed in docs.brain.fi. Page citations use
the canonical `.md` paths from `https://docs.brain.fi/sitemap.md`.

### 1.1 Top-level (convenience) surface

| Method | Signature | Returns | Pages |
| --- | --- | --- | --- |
| `new Brain(config)` | `{ apiKey, agentSigner?, environment?: "sandbox"\|"production", defaultTenantId? }` | `Brain` instance | `introduction/quickstart`, `sdks/overview`, `sdks/quickstart` |
| `brain.ask(tenantId, question)` | `(string, string)` | `{ text, citations }` | `introduction/quickstart`, `build/overview`, `build/read-a-financial-picture` |
| `brain.pay(tenantId, opts)` | `opts = { invoiceId } \| { to: { counterpartyId }, amount, currency, memo? } & { idempotencyKey? }` | `{ id, status: "auto"\|"needs_approval"\|"rejected", receipt?, approvers?, reason? }` | `introduction/quickstart`, `build/pay-an-invoice-safely` |
| `brain.approve(actionId, { as })` | `(string, { as: string })` — also seen as `(actionId, { approval: EIP712Signature })` | not specified | `introduction/quickstart`, `build/pay-an-invoice-safely`, `sdks/agents-and-actions` |
| `brain.reject(actionId, { as, reason })` | — | not specified | `build/pay-an-invoice-safely` |
| `brain.proof(actionId)` | `(string)` | `{ txHash?, railReceipt?, merklePath, event?, anchorRoot, anchorTx, anchorBlock }` | `introduction/quickstart`, `build/pay-an-invoice-safely`, `build/audit-every-action` |
| `brain.trace(actionId)` | `(string)` | `{ events: AuditEvent[] }` | `build/audit-every-action` |
| `brain.snapshot(tenantId)` | `(string)` | `{ accounts, transactions, obligations, counterparties, cashFlow }` | `build/read-a-financial-picture` |

### 1.2 Namespaced surface

`brain.auth`

| Method | Signature | Returns | Pages |
| --- | --- | --- | --- |
| `auth.signInWithSIWX()` | `()` | `Promise<void>` (manages session) | `sdks/overview` |

`brain.tenants`

| Method | Signature | Returns | Pages |
| --- | --- | --- | --- |
| `tenants.get(tenantId)` | `(string)` | `{ displayName, … }` | homepage, `introduction/quickstart` |

`brain.sources`

| Method | Signature | Returns | Pages |
| --- | --- | --- | --- |
| `sources.connect(tenantId, { type, credentials })` (positional) | also seen as `sources.connect({ tenantId, type, credentials })` (object) | source record | `introduction/quickstart`, `sdks/quickstart` |
| `sources.get(sourceId)` | `(string)` | source record | `sdks/quickstart` |

`brain.accounts`, `brain.transactions`, `brain.obligations`, `brain.counterparties`, `brain.cashFlow`

| Method | Signature | Returns | Pages |
| --- | --- | --- | --- |
| `accounts.list(tenantId)` | `(string)` | `Account[]` | `build/read-a-financial-picture` |
| `transactions.list(tenantId, opts)` | `opts = { from?, to?, direction?, counterpartyId?, minAmount?, status?, limit?, cursor? }` | `{ data, nextCursor }` | `build/read-a-financial-picture` |
| `transactions.subscribe(tenantId, handlers)` | handlers: `{ onCreated, onUpdated, onSuperseded }` | `unsubscribe()` | `build/read-a-financial-picture` |
| `obligations.list(tenantId, { status })` | `status: ("upcoming"\|"due"\|"overdue")[]` | `Obligation[]` | `build/read-a-financial-picture` |
| `counterparties.list(tenantId, { sortBy, limit })` | `sortBy: "activity"` | `Counterparty[]` | `build/read-a-financial-picture` |
| `counterparties.update(tenantId, counterpartyId, { status })` | `status: "approved"` | — | `build/give-an-agent-a-spending-limit` |
| `cashFlow.summarize(tenantId, { days })` | — | cashflow summary | `build/read-a-financial-picture` |

`brain.wiki`

| Method | Signature | Returns | Pages |
| --- | --- | --- | --- |
| `wiki.question({ tenantId, question })` | object args | `{ text, citations: Citation[], confidence, policy_version, audit_event_id }` | `sdks/overview`, `sdks/wiki`, `sdks/quickstart` |
| `wiki.getEntity({ tenantId, entityId })` | — | entity record | `sdks/wiki` |
| `wiki.getRelated({ tenantId, entityId, relationship })` | — | related entities | `sdks/wiki` |
| `wiki.search({ tenantId, query, limit })` | — | entities + similarity | `sdks/wiki` |

`Citation` discriminated union (`sdks/wiki`):

```ts
type Citation =
  | { type: "ledger.transaction"; id: string }
  | { type: "ledger.invoice";     id: string }
  | { type: "ledger.balance";     id: string }
  | { type: "raw.artifact";       sha256: string }
  | { type: "wiki.entity";        id: string };
```

`brain.policy`

| Method | Signature | Returns | Pages |
| --- | --- | --- | --- |
| `policy.create({ tenantId, text })` | object args | `{ id, compiled, explanation, policy_hash, status: "draft", rules? }` | `build/give-an-agent-a-spending-limit`, `sdks/policy` |
| `policy.activate(policyId)` | `(string)` | — | `build/give-an-agent-a-spending-limit` |
| `policy.sign(policyId, { signer \| signature })` | `(string, …)` | `{ status: "active", version, anchored_tx_hash }` | `sdks/policy`, `sdks/quickstart` |
| `policy.evaluate({ tenantId, action })` or `policy.evaluate(tenantId, action)` | both forms shown | `{ decision, policy_version, signed_verdict, expires_at, matchedRule?, approvers? }` | `build/give-an-agent-a-spending-limit`, `sdks/policy` |
| `policy.simulate(policyId, { action })` | — | `{ decision, reason, approvers, matched_rule_index }` | `sdks/policy`, `sdks/quickstart` |
| `policy.getActive(tenantId)` | `(string)` | `{ version, policy_hash, compiled, signed_at, anchored_tx_hash }` | `sdks/policy` |
| `policy.getVersion(tenantId, version)` | `(string, number)` | policy record | `sdks/policy` |
| `policy.revoke({ tenantId, version, signer })` | — | — | `sdks/policy` |

`brain.agents`

| Method | Signature | Returns | Pages |
| --- | --- | --- | --- |
| `agents.register({ address, identityRoot, mcpEndpoint, capabilities, metadataUri? })` | no `tenantId` in this call form | `{ id, address, identity_root, reputation_root, txHash? }` | `build/let-an-external-agent-in`, `sdks/agents-and-actions` |
| `agents.register({ tenantId, agentAddress, capabilities, mcpEndpoint })` | alt form with `tenantId` | — | `sdks/quickstart` |
| `agents.grantScope(tenantId, agentId, { scopes, validFrom, validTo })` | positional | grant record | `build/let-an-external-agent-in` |
| `agents.grantScope({ tenantId, agentAddress, capability, scopeAttestation })` | alt object form | — | `sdks/agents-and-actions` |
| `agents.propose({ tenantId, agentId, action })` | — | `{ actionId, decision: "ALLOW"\|"ESCALATE"\|"DENY", policy_version, approvers?, audit_event_id, wiki_context?, reason? }` | `sdks/agents-and-actions`, `sdks/quickstart` |
| `agents.pause(agentId)` | `(string)` | — | `sdks/agents-and-actions` |
| `agents.resume(agentId)` | `(string)` | — | `sdks/agents-and-actions` |
| `agents.revoke(tenantId, agentId)` / `revoke(agentId)` | both | — | `build/let-an-external-agent-in`, `sdks/agents-and-actions` |
| `agents.subscribe(agentId, handlers)` | `handlers = { onProposed, onAllowed, onEscalated, onDenied, onExecuted }` | `unsubscribe()` | `sdks/agents-and-actions` |

`brain.actions`

| Method | Signature | Returns | Pages |
| --- | --- | --- | --- |
| `actions.execute(actionId)` | `(string)` | `{ tx_hash, rail: "bank_api"\|"smart_account"\|"x402", settled_at, audit_event_id }` | `sdks/agents-and-actions`, `sdks/quickstart` |
| `actions.approve(actionId, { approval })` | EIP-712 signed approval | — | `sdks/agents-and-actions` |

> Note for the SDK: `actions.execute` **is** documented as a public SDK method
> (see `sdks/agents-and-actions.md` and `sdks/quickstart.md`). The user-supplied
> guard "If the docs do not expose execute, the SDK does not either" is therefore
> satisfied — the docs **do** expose it. The SDK ships `actions.execute`.

`brain.audit`

| Method | Signature | Returns | Pages |
| --- | --- | --- | --- |
| `audit.list(tenantId, { from, to, type, actor, eventType?, limit? })` | — | `{ data: AuditEvent[] }` | `build/audit-every-action`, `sdks/audit` |
| `audit.get(eventId)` | `(string)` | `AuditEvent` | `sdks/audit` |
| `audit.proof(eventId)` | also called via top-level `brain.proof(actionId)` | `{ event, merkle_path, anchored_root, base_tx_hash, base_block, batch_index }` | `build/audit-every-action`, `sdks/audit`, `sdks/quickstart` |
| `audit.getByHash(prevEventHash)` | `(string)` | `AuditEvent` | `sdks/audit` |
| `audit.subscribe(tenantId, { onEvent })` | — | `unsubscribe()` | `build/audit-every-action`, `sdks/audit` |
| `audit.export({ tenantId, format: "soc2"\|"iso27001"\|"financial_controls"\|"raw_jsonl"\|"ndjson"\|"csv", from, to })` | format set differs across pages — see §5 | `{ id }` | `build/audit-every-action`, `sdks/audit` |
| `audit.exportStatus(jobId)` | `(string)` | `{ state: "ready"\|…, downloadUrl }` | `build/audit-every-action` |
| `audit.exportProof(eventId)` | `(string)` | `{ shareUrl }` | `sdks/audit` |

Utility export (`sdks/audit`):

```ts
import { verifyMerkleProof } from "@brain/sdk";
// verifyMerkleProof({ leaf, path, root }): boolean
```

### 1.3 Exported types (per `sdks/overview`)

`Tenant`, `Source`, `LedgerRecord`, `WikiAnswer`, `Policy`, `Agent`, `Action`,
`ActionDecision`, `AuditEvent`, `MerkleProof`. The SDK must export each.

---

## 2. HTTP endpoint reconciliation

Comparison of every HTTP path the docs mention against `Brain_API_Specification.yaml`.

### 2.1 Endpoints in docs that are missing or renamed in the OpenAPI spec

| Docs endpoint | Page | In spec? | Note |
| --- | --- | --- | --- |
| `POST /v1/sources` | `api-reference/sources-api`, `products/brain-api` | ✗ | Spec has only `/raw/ingest` and `/raw/webhooks/{provider}`. Source connection lifecycle (`connect`, `list`, `get`, `delete`, `sync`) is undocumented in the spec. |
| `GET /v1/sources` | `api-reference/sources-api` | ✗ | — |
| `GET /v1/sources/{id}` | `api-reference/sources-api` | ✗ | — |
| `DELETE /v1/sources/{id}` | `api-reference/sources-api` | ✗ | — |
| `POST /v1/sources/{id}/sync` | `api-reference/sources-api` | ✗ | — |
| `GET /v1/ledger/cash_flows` | `api-reference/ledger-api` | ✗ | Backs `brain.cashFlow.summarize`. |
| `GET /v1/ledger/assets` | `api-reference/ledger-api` | ✗ | Out of MVP per Architecture §3.5 ("positions, securities, … post-MVP") — flag for human resolution. |
| `GET /v1/ledger/liabilities` | `api-reference/ledger-api` | ✗ | Same as above. |
| `GET /v1/ledger/events` | `api-reference/ledger-api` | ✗ | New. |
| `GET /v1/ledger/reconciliation_queue` | `api-reference/ledger-api` | ✗ | New. Reconciliation matches in spec live at `/ledger/reconciliation-matches` (hyphen). |
| `GET /v1/ledger/{id}` | `api-reference/ledger-api` | ✗ | Polymorphic-by-id read; spec uses per-entity routes. |
| `WSS /v1/ledger/stream` | `api-reference/ledger-api` | ✗ | Streaming subscriptions are absent from spec. |
| `WSS /v1/audit/stream` | `api-reference/audit-api` | ✗ | Backs `brain.audit.subscribe`. |
| `WSS /v1/wiki/stream` | `api-reference/wiki-api` | ✗ | — |
| `WSS /v1/actions/{action_id}/events` | `api-reference/actions-api` | ✗ | Backs `agents.subscribe`. |
| `GET /v1/wiki/entities/{id}` | `api-reference/wiki-api` | ≈ | Spec exposes `/wiki/entity/{entity_id}` (singular) — docs use `/wiki/entities/{id}` (plural). **Doc wins; rename spec.** |
| `GET /v1/wiki/entities/{id}/relationships` | `api-reference/wiki-api` | ✗ | Spec has `/wiki/entity/{id}` with `include_neighbors` query, not a sub-route. |
| `POST /v1/wiki/search` | `api-reference/wiki-api` | ≈ | Spec uses `GET /wiki/search`. Docs say `POST`. |
| `POST /v1/wiki/semantic_search` | `api-reference/wiki-api` | ✗ | Spec folds semantic into `GET /wiki/search`'s `semantic` query param. Docs split them. |
| `POST /v1/policy` | `api-reference/policy-api`, `products/brain-api` | ≈ | Spec uses `POST /policy/{tenant_id}/compose`. Docs collapse compose+sign into create+register. |
| `POST /v1/policy/{policy_id}/register` | `api-reference/policy-api` | ≈ | Maps onto spec's `POST /policy/{tenant_id}/sign` semantically. |
| `GET /v1/policy/active?tenantId=` | `api-reference/policy-api` | ≈ | Spec uses `GET /policy/{tenant_id}`. |
| `POST /v1/policy/evaluate` | `api-reference/policy-api` | ≈ | Spec uses `POST /policy/{tenant_id}/evaluate`. |
| `POST /v1/policy/{policy_id}/revoke` | `api-reference/policy-api` | ✗ | New. Spec has no revoke route. |
| `GET /v1/policy/history?tenantId=` | `api-reference/policy-api` | ≈ | Spec: `GET /policy/{tenant_id}/versions`. |
| `POST /v1/agents` | `api-reference/agents-api`, `products/brain-api` | ≈ | Spec: `POST /agents/register`. |
| `POST /v1/agents/{agent_address}/scope` | `api-reference/agents-api` | ✗ | Backs `agents.grantScope`. |
| `POST /v1/agents/{agent_id}/pause` | `api-reference/agents-api` | ✗ | New. |
| `POST /v1/agents/{agent_id}/resume` | `api-reference/agents-api` | ✗ | New. |
| `DELETE /v1/agents/{agent_id}` | `api-reference/agents-api` | ✗ | New. |
| `GET /v1/agents/{agent_address}/reputation` | `api-reference/agents-api` | ✗ | New. Reputation surface is unmodeled. |
| `POST /v1/agents/{agent_address}/attest` | `api-reference/agents-api` | ✗ | New. |
| `GET /v1/actions/{action_id}` | `api-reference/actions-api` | ✗ | Spec has `/payment-intents/{id}`. **See §6, conflict A.** |
| `POST /v1/actions/{action_id}/approve` | `api-reference/actions-api`, `products/brain-api` | ✗ | Spec: `/payment-intents/{id}/approve`. |
| `POST /v1/actions/{action_id}/execute` | `api-reference/actions-api`, `products/brain-api` | ✗ | Spec: `/payment-intents/{id}/execute`. |
| `GET /v1/actions` | `api-reference/actions-api` | ✗ | New. |
| `DELETE /v1/actions/{action_id}` | `api-reference/actions-api` | ✗ | New (cancel). |
| `GET /v1/audit/{event_id}` | `api-reference/audit-api`, `products/brain-api` | ≈ | Spec: `GET /audit/event/{event_id}`. Docs flatten. |
| `GET /v1/audit/{event_id}/proof` | `api-reference/audit-api` | ✗ | Spec returns proof inline on `/audit/event/{event_id}`. |
| `GET /v1/audit` (list) | `api-reference/audit-api` | ≈ | Spec: `GET /audit/events`. |
| `POST /v1/public/audit/verify` | `api-reference/audit-api` | ≈ | Spec: `POST /audit/verify` (no `/public` prefix). Docs add explicit public prefix. |
| `POST /v1/audit/exports` (and `GET /v1/audit/exports/{id}`) | `api-reference/audit-api` | ≈ | Spec: `POST /audit/export`. Pluralization differs. Spec lacks export-status GET. |
| `POST /v1/auth/siwx` | `products/brain-api` | ✗ | Whole `/auth/*` family is absent. |
| `GET /v1/ledger/payment-intents` | `protocol/payment-intents` | ✗ | Cross-entity Ledger query for payment intents; spec exposes them only by id under `/payment-intents/*`. |

### 2.2 Endpoints in the OpenAPI spec that the docs no longer mention

The whole legacy `/execution/*` family — `/execution/propose`, `/execution/execute`,
`/execution/{execution_id}`, `/execution/approve`, `/execution/escalate`,
`/execution/agents`, `/execution/agents/register`, `/execution/agents/{agent_id}`
— is not present anywhere on docs.brain.fi (none of the API-reference, SDK,
build, or protocol pages reference them). The user has already instructed they
should remain in the spec with `deprecated: true` and a description pointing at
the v0.3 equivalents — see Phase 3 plan in §7 below.

These spec-only endpoints also have no doc page:

- `GET /raw/{raw_id}`, `DELETE /raw/{raw_id}`, `GET /raw/{raw_id}/parsed` (Raw retrieval)
- `POST /ledger/normalize`, `POST /ledger/reconcile` (Ledger writers)
- `POST /memory/regenerate`, `GET /memory/pages`, `GET /memory/pages/{slug_or_id}`, `GET /memory/search` (Wiki memory pages — spec has both `/memory/*` and `/wiki/*`, docs only mention `/wiki/*`)
- `GET /policy/decisions/{id}` (PolicyDecision read-back)
- `POST /policy/{tenant_id}/simulate` (matches `brain.policy.simulate` shape but spec keeps it tenant-scoped)
- `POST /agents/{agent_id}/propose`, `GET /agents/{agent_id}/actions` (the SDK uses these — spec keeps them but the doc API-reference uses `/v1/agents/{id}/propose` only)

Verdict for §7: leave these in the spec as-is unless contradicted by a doc page;
docs silence ≠ deletion.

### 2.3 Endpoints in spec and docs that agree

`POST /v1/raw/ingest`, `POST /v1/raw/webhooks/{provider}` (Raw),
`GET /v1/ledger/{accounts,balances,transactions,counterparties,obligations,invoices}`,
`POST /v1/wiki/question`, `POST /v1/policy/{tenant_id}/evaluate` (semantically
equivalent to docs' `/v1/policy/evaluate`),
`POST /v1/agents/{agent_id}/propose`, `POST /v1/agents/register` (docs name
varies), `POST /v1/agents/mcp` (MCP JSON-RPC entry),
`/v1/payment-intents/{id}/{approve,reject,execute}` (per `protocol/payment-intents`).

---

## 3. Error code reconciliation

### 3.1 Docs canonical list (`resources/errors.md`)

The docs use **`SCREAMING_SNAKE_CASE`** for error codes. The full registry:

```
Auth:      AUTH_INVALID_KEY, AUTH_EXPIRED, AUTH_SIWX_INVALID, SCOPE_INSUFFICIENT
Tenant:    TENANT_NOT_FOUND, TENANT_SUSPENDED, TENANT_ACCESS_DENIED
Source:    SOURCE_NOT_FOUND, SOURCE_RATE_LIMIT, SOURCE_CREDENTIAL_INVALID
Policy:    POLICY_NOT_ACTIVE, POLICY_DENIED, POLICY_ESCALATE
Agent:     AGENT_NOT_FOUND, AGENT_INACTIVE, SCOPE_HASH_MISMATCH, SCOPE_EXPIRED
Action:    ACTION_NOT_FOUND, ACTION_ALREADY_EXECUTED, INSUFFICIENT_BALANCE,
           LIMITS_EXCEEDED, IDEMPOTENCY_KEY_REUSED
Gate:      GATE_NO_POLICY_DECISION, GATE_POLICY_VERSION_STALE,
           GATE_COUNTERPARTY_UNVERIFIED, GATE_COUNTERPARTY_SANCTIONED,
           GATE_BALANCE_INSUFFICIENT, GATE_APPROVAL_INCOMPLETE,
           GATE_SESSION_KEY_INVALID, GATE_AUDIT_CHAIN_STALE
Rate:      RATE_LIMITED
Valid:    VALIDATION_FAILED, MISSING_REQUIRED_FIELD, INVALID_CURSOR
Server:    INTERNAL_ERROR, UPSTREAM_TIMEOUT, MAINTENANCE_MODE
MCP RPC:   -32001..-32005, -32600..-32603
```

### 3.2 Local `services/api/src/shared/errors.ts` registry (lowercase snake_case)

Current registry: see file. It uses `auth_token_*`, `wiki_*`, `policy_*`,
`execution_*` (v0.1 names — the Standards §4.3 v0.2 update added `ledger_*`,
`agent_*`, `payment_intent_*` aliases, but errors.ts has not yet been updated).

### 3.3 Mapping table

Per the user's directive, the docs are source of truth. Codes the SDK must
recognize / re-export — and that `services/api/src/shared/errors.ts` must register
(Phase 3 change):

| Docs code | Best local mapping today | Action |
| --- | --- | --- |
| `AUTH_INVALID_KEY` | `auth_token_invalid` | rename/alias |
| `AUTH_EXPIRED` | `auth_token_expired` | rename/alias |
| `AUTH_SIWX_INVALID` | (none) | add |
| `SCOPE_INSUFFICIENT` | `auth_scope_insufficient` | rename/alias |
| `TENANT_NOT_FOUND` | (none) | add |
| `TENANT_SUSPENDED` | (none) | add |
| `TENANT_ACCESS_DENIED` | `auth_tenant_mismatch` | rename/alias |
| `SOURCE_NOT_FOUND` | (none) | add |
| `SOURCE_RATE_LIMIT` | (none) — `rate_limit_exceeded` is global, this is provider-scoped | add |
| `SOURCE_CREDENTIAL_INVALID` | (none) | add |
| `POLICY_NOT_ACTIVE` | (none — `policy_not_found` is for missing) | add |
| `POLICY_DENIED` | (none) | add |
| `POLICY_ESCALATE` | (none) | add |
| `AGENT_NOT_FOUND` | (none) | add — Standards §4.3 v0.2 already names `agent_not_registered` as an alias for `execution_agent_not_registered`; widen to cover not-found vs. not-registered |
| `AGENT_INACTIVE` | (none) | add |
| `SCOPE_HASH_MISMATCH` | (none) | add — Standards §4.3 v0.2 names this `agent_scope_hash_mismatch` informally in OpenAPI; needs first-class registry entry |
| `SCOPE_EXPIRED` | (none) | add |
| `ACTION_NOT_FOUND` | `execution_proposal_not_found` / `agent_proposal_not_found` | add — these are not the same thing in v0.3, since "action" in docs covers both Proposal and PaymentIntent |
| `ACTION_ALREADY_EXECUTED` | (none — but `execution_proposal_invalid_state` is in the same family) | add |
| `INSUFFICIENT_BALANCE` | (none — gate failure carries this) | add |
| `LIMITS_EXCEEDED` | (none) | add |
| `IDEMPOTENCY_KEY_REUSED` | `execution_idempotency_conflict` | rename/alias |
| `GATE_*` (8 codes) | one local code `payment_intent_gate_failed` covers all 8 today | split — docs publish 8 specific gate codes, each must exist |
| `RATE_LIMITED` | `rate_limit_exceeded` | rename/alias |
| `VALIDATION_FAILED` | `request_body_invalid` | rename/alias |
| `MISSING_REQUIRED_FIELD` | `request_body_invalid` (no field-grain code) | add |
| `INVALID_CURSOR` | `request_params_invalid` (close, not exact) | add |
| `INTERNAL_ERROR` | `internal_server_error` | rename/alias |
| `UPSTREAM_TIMEOUT` | `dependency_unavailable` | rename/alias |
| `MAINTENANCE_MODE` | (none) | add |
| `-32001..-32005` | spec maps to local codes — but docs disagree on which (see §6 conflict G) | reconcile in Phase 3 |

### 3.4 Error envelope shape

Docs (`api-reference/overview`):

```json
{ "error": { "code": "...", "message": "...", "details": { ... }, "trace_id": "..." } }
```

Standards §4.1:

```json
{ "error": { "code": "...", "message": "...", "details": { ... }, "request_id": "...", "docs_url": "..." } }
```

Spec `Error` schema:

```json
{ "code": "...", "message": "...", "trace_id": "...", "details": { ... } }
```

The docs and Standards both wrap in `{ error: { … } }`; the spec doesn't. The
docs name the correlation id `trace_id`; the Standards (and errors.ts) name it
`request_id`. **See §6 conflict E.**

---

## 4. Naming registry

The names the SDK must use (and that other code must use consistently).

| Identifier kind | Canonical value (per docs) | Sources |
| --- | --- | --- |
| npm package name | `@brain/sdk` | every code sample on the site |
| Top-level class | `Brain` | every code sample |
| Constructor option for credentials | `apiKey` | `introduction/quickstart`, `sdks/overview`, `sdks/quickstart` |
| Env var | `BRAIN_API_KEY` | `introduction/quickstart` |
| Sandbox key prefix | `brain_sk_test_` | `introduction/quickstart`, `resources/errors` |
| Production key prefix | `brain_sk_live_` | `introduction/quickstart` |
| Top-level namespaces | `auth`, `sources`, `ledger`, `wiki`, `policy`, `agents`, `actions`, `audit` | `sdks/overview` (canonical list) — also `tenants`, `accounts`, `transactions`, `obligations`, `counterparties`, `cashFlow` per build pages |
| Public SDK types (must be exported) | `Tenant`, `Source`, `LedgerRecord`, `WikiAnswer`, `Policy`, `Agent`, `Action`, `ActionDecision`, `AuditEvent`, `MerkleProof` | `sdks/overview` |
| Smart-contract names | `BrainAuditAnchor`, `BrainPolicyRegistry`, `BrainSmartAccount`, `BrainMCPAgentRegistry` | `smart-contracts/*` (matches Architecture §4) |
| API base URL — production | `https://api.brain.fi` (no `/v1` in base — see conflict F) | `api-reference/overview`, `mcp-server/api-reference` |
| MCP endpoint | `POST /v1/agents/mcp` on `api.brain.fi`; also surfaced at `mcp.brain.fi` / `mcp.brain.dev` (see conflict H) | `mcp-server/*`, `build/let-an-external-agent-in` |

No occurrence of `@brain-protocol/sdk` or any other package name variant was
found on docs.brain.fi as of this audit. The package name is unambiguously
`@brain/sdk` everywhere — recording the negative result per the prompt's "flag
variants if you see them" instruction.

---

## 5. Internal doc conflicts — flag for human resolution

These are conflicts **inside the docs themselves**, between two doc pages. The
prompt explicitly says not to silently pick a side; this section enumerates them
for the doc owner. The SDK scaffold cannot proceed on these until they are
resolved (or until we get permission to pick a side temporarily).

### Conflict A — "action" vs. "payment-intent" as the HTTP resource name

- `api-reference/actions-api.md` and `products/brain-api.md` route via `/v1/actions/{action_id}/{approve,execute}` and call the resource an **action**.
- `protocol/payment-intents.md` routes via `/v1/payment-intents/{id}/{approve,reject,execute}` and calls it a **PaymentIntent**.
- The SDK consistently exposes both: `brain.pay(...).status` returns an `action.id`, `brain.actions.execute(actionId)` exists, and `brain.audit.list({ type: "action.executed" })` is used. The SDK uses "action" exclusively.

The protocol page and the SDK can be reconciled — the SDK uses "action" as the
user-facing label while the protocol calls it PaymentIntent under the hood. But
the **HTTP routes** must pick one. The SDK has to call something. Two candidates:

1. The SDK calls `/v1/payment-intents/*` (matches `protocol/payment-intents.md` and the OpenAPI spec). The API-reference page's `/v1/actions/*` family is removed from the docs.
2. The SDK calls `/v1/actions/*`. The OpenAPI spec is updated to add `/actions/*` and either keep or remove `/payment-intents/*`.

Recommendation (not adopted without approval): option 1, with `/actions/*`
appearing in docs as a deprecated alias for `/payment-intents/*` only if both
must coexist. The SDK exposes `actions` as the surface name regardless.

### Conflict B — Decision enum vocabulary

Three different enum vocabularies appear:

| Source | Values |
| --- | --- |
| `introduction/quickstart`, `build/pay-an-invoice-safely`, `build/give-an-agent-a-spending-limit` | `"auto"`, `"needs_approval"`, `"rejected"` |
| Standards §6, OpenAPI spec `PolicyDecision`, `protocol/payment-intents` | `"allow"`, `"confirm"`, `"reject"` |
| `api-reference/actions-api`, `api-reference/policy-api`, `sdks/agents-and-actions`, `sdks/policy` | `"ALLOW"`, `"ESCALATE"`, `"DENY"` |

The SDK can only export one `ActionDecision` type. Pick one. Likeliest mapping:
the SDK's `Action.status` is `"auto" | "needs_approval" | "rejected"` (the
caller-facing values) and the SDK's `PolicyDecision.decision` is the canonical
protocol value (`"allow"|"confirm"|"reject"` or `"ALLOW"|"ESCALATE"|"DENY"`). But
the `Action.decision` vs. `Action.status` distinction is itself unclear in the
docs.

### Conflict C — Agent capability/scope vocabulary

Four vocabularies seen in docs:

1. `["ledger:read", "wiki:read", "raw:write", "payment_intent:propose", "agent:propose"]` — `build/let-an-external-agent-in` (in the `grantScope` call), `mcp-server/tools.md`, `protocol/agent-contributions`. **Matches Architecture §3.2.**
2. `["read", "propose_payment", "propose_action"]` — `build/let-an-external-agent-in` (in the `agents.register` call on the **same page** as #1).
3. `["pay_invoice", "rebalance_treasury"]` — `api-reference/agents-api` register example.
4. `subject: "pay_invoice"` plus `capability` in scope grants — `sdks/policy`, `api-reference/agents-api` grantScope example.

Two of these (#1 and #2) appear on the same page, which is the clearest signal
that the docs are mid-flight. Resolution required before `agents.register` and
`agents.grantScope` can be implemented.

Recommendation (not adopted without approval): #1 is canonical (it matches the
Architecture and the MCP tool registry, and is the only vocabulary that
appears in three independent doc sections). #2, #3, #4 are abbreviations or
domain-specific labels and should be replaced.

### Conflict D — SDK call style: positional `(tenantId, …)` vs. object `({ tenantId, … })`

Two competing conventions:

- `introduction/quickstart`, `build/*` use positional first-arg `tenantId`: `brain.pay("acme", { invoiceId })`, `brain.transactions.list("acme", { … })`.
- `sdks/quickstart`, `sdks/wiki`, `sdks/policy`, `sdks/agents-and-actions` use object args: `brain.wiki.question({ tenantId, question })`, `brain.policy.create({ tenantId, text })`, `brain.agents.propose({ tenantId, agentId, action })`.

Some methods are shown in both forms on different pages (e.g. `agents.grantScope`).
The SDK cannot ship two signatures for the same method without a function-overload
strategy or a union type that's painful in TS.

Recommendation (not adopted without approval): object args throughout — they
extend more gracefully. Convenience top-level methods (`brain.ask`, `brain.pay`,
`brain.approve`, `brain.reject`, `brain.proof`, `brain.trace`, `brain.snapshot`)
keep their positional `tenantId` first since that's how every Build guide is
written.

### Conflict E — Error envelope correlation-id field name

- Docs (`api-reference/overview`): `trace_id`.
- Standards §4.1 and OpenAPI spec (Error schema): `request_id` per Standards;
  `trace_id` per spec. The spec already disagrees with the Standards.
- `services/api/src/shared/errors.ts` uses `request_id`.

The docs choose `trace_id`. The SDK must surface whichever the API actually
emits. Pick one and update both spec and `errors.ts`. Recommendation: `trace_id`,
since the docs win.

### Conflict F — API base URL

- `api-reference/overview`: production `https://api.brain.fi`, sandbox `https://api.brain.fi/sandbox`.
- `mcp-server/api-reference`: sandbox **`api.brain.dev`** (Base Sepolia), production `api.brain.fi` (Base mainnet).
- OpenAPI spec: production `https://api.brain.fi/v1`, sandbox `https://api.sandbox.brain.fi/v1`.

Three different sandbox URLs. The SDK constructor takes `environment:
"sandbox"|"production"` (per `sdks/quickstart`), so the SDK has to know the
canonical sandbox base URL. Recommendation: align on `api.brain.dev` (matches
the MCP page and matches the `console.brain.dev` sandbox console URL shown in
the quickstart).

Also note: the docs prefix `/v1/` on the path, not on the base URL. The spec
includes `/v1` in the base URL. SDK choice: include `/v1` in the request path,
not in the base URL — matches the `https://api.brain.fi` base value the docs
publish.

### Conflict G — MCP error code (-32001..-32005) mappings

- OpenAPI spec `McpErrorCode`: `-32001=auth_token_missing`, `-32002=auth_scope_insufficient`, `-32003=agent_not_registered`, `-32004=payment_intent_gate_failed`, `-32005=agent_scope_hash_mismatch`.
- `api-reference/mcp-server-api-reference.md`: `-32001=JWT invalid/expired`, `-32002=agent inactive`, `-32003=scope hash mismatch`, `-32004=insufficient per-call scope`, `-32005=tenant mismatch`.
- `mcp-server/tools.md`: per-call scope mismatch returns `-32004`.

These are wholly incompatible. Resolution required before the MCP code lands.
The SDK does not surface JSON-RPC codes directly (it surfaces error names), so
the SDK can ship behind whichever mapping is picked.

### Conflict H — MCP endpoint location

- `mcp-server/api-reference.md`: `POST /v1/agents/mcp` on `api.brain.fi` (matches OpenAPI spec).
- `build/let-an-external-agent-in.md`: production `mcp.brain.fi`, sandbox `mcp.brain.dev`.

Possibly compatible if `mcp.brain.fi` is a CNAME to `api.brain.fi/v1/agents/mcp`,
but ambiguous. Resolution required.

### Conflict I — Authentication model

- `introduction/quickstart`: `new Brain({ apiKey: process.env.BRAIN_API_KEY })`, key prefix `brain_sk_*`.
- `api-reference/authentication.md`: three caller types — humans via OAuth/Auth0, internal agents via Brain-issued service token, external agents via SIWX-exchanged agent token. Header: `Authorization: Bearer <token>` for all.
- `api-reference/overview.md`: "Humans: OAuth/SSO (Auth0); Agents: SIWX + EIP-712 ScopeAttestations".
- Standards §3.1: bearer JWT on every endpoint, payload includes tenant_id and scopes.

These can be reconciled: the SDK's `apiKey` is one **kind** of bearer token (the
backend-server kind). Humans use OAuth, external agents use SIWX exchange, and
backends use server keys — all three become `Authorization: Bearer <token>` on
the wire. The SDK ships the server-key path first (matches every Build sample);
SIWX support is `auth.signInWithSIWX()` and is documented but additional.

### Conflict J — Pre-execution gate checks

- Standards §6.2 lists 13 deterministic checks (agent identity, agent
  authorization, action allowed, source account allowed, counterparty allowed,
  counterparty verified, amount within policy limit, available balance, evidence,
  approval requirement, approval granted, PolicyDecision row, audit before+after).
- `protocol/the-pre-execution-gate.md` lists a **different** 13 checks
  (PaymentIntent exists+approved, PolicyDecision matches, idempotency reuse,
  source account active, balance ≥ amount, counterparty verified, counterparty
  not sanctioned, approver sigs match decision id, policy hash on-chain,
  session-key validity, rail limits, no conflicting in-flight, audit chain
  healthy).
- The docs `resources/errors.md` ships **8** `GATE_*` codes (which match neither
  list directly).

These are similar in spirit but the order and exact criteria differ. The SDK is
not affected directly (the gate runs server-side) but the gate's failure codes
matter — see §3.3, "split GATE\_\*".

### Conflict K — Source type vocabulary

- `api-reference/sources-api.md`: 16 source types (banking, on-chain, ERP,
  accounting, payroll, processors, documents).
- Architecture §3.1 MVP scope: 6 source types (`plaid`, `erp_netsuite`, `email`,
  `upload`, `chain_evm`, `agent_contributed`); spec adds `stripe` and `other`.
- The discrepancy is large. Many of the doc's listed types (`sap`, `dynamics_365`,
  `quickbooks_online`, `xero`, `gusto`, `rippling`, `adp`, `adyen`,
  `solana_address`, `bank_direct`, `alchemy_wallet`, `eth_address`, `pdf_upload`)
  are out of MVP scope per Architecture §3.1 ("Other source-specific adapters …
  are post-MVP").

The SDK can ship a permissive `string` for `type` and let the server validate.
For the **type union** in `Source`, the audit's resolution recommendation: emit
the doc's listed types literally; the server returns an error if unsupported.

### Conflict L — Audit export format vocabulary

- `build/audit-every-action`: `format: "ndjson" | "csv"`.
- `sdks/audit`, `api-reference/audit-api`: `format: "soc2" | "iso27001" | "financial_controls" | "raw_jsonl"`.
- Architecture §3.6: "JSONL and CSV. SOX-ready PDF is post-MVP."
- OpenAPI spec `/audit/export`: `format: "jsonl" | "csv"`.

Resolution required. The SDK's `format` union has to include something.

### Conflict M — Section parallelism in the docs

The sitemap contains the following parallel sections:

- `/concepts/*` vs. `/core-concepts/*` — same six topics each. Not a content
  conflict per se but a navigation duplication; flag for the docs team.
- `/protocol/*` vs. `/architecture/*` — overlapping coverage of the six-layer
  stack, data flow, write paths.
- `/api-reference/*` vs. `/apis/*` — both name an API reference family.
- `/sdks/*` vs. (no parallel section) — the canonical SDK reference.
- `/smart-contracts/*` vs. `/smart-contracts-old/*` — old explicitly marked,
  ignore.

The audit pulls from the most recent/authoritative section for each topic
(`/api-reference/*`, `/protocol/*`, `/sdks/*`, `/smart-contracts/*`); the parallel
sections were spot-checked and did not contribute additional unique content.
Flag for the docs team that the parallel sections should be merged or one set
deleted.

---

## 6. Phase 2 inputs (for after approval)

The SDK scaffold needs the audit's outputs distilled into concrete decisions:

1. **HTTP routing**: `/v1/payment-intents/*` (per protocol page + spec) OR
   `/v1/actions/*` (per api-reference + SDK surface). Pending conflict A.
2. **Constructor**: `new Brain({ apiKey, environment, baseUrl?, fetch?, agentSigner?, defaultTenantId? })`. Plus a `fetch` option for runtime portability per the prompt.
3. **Action / Decision enums**: pending conflict B.
4. **Capability vocabulary** for `agents.register` / `agents.grantScope`: pending conflict C.
5. **Call style**: pending conflict D — recommendation is object args, with positional only on convenience methods.
6. **Error registry exports**: 47 codes (docs canonical) re-exported as typed classes; each mapped to an HTTP status and to the local `services/api/src/shared/errors.ts` registry. Pending the rename/alias additions in Phase 3.
7. **Idempotency**: every mutating call accepts a caller-provided `idempotencyKey` (matches `build/pay-an-invoice-safely`); the SDK generates one (ULID) when the caller omits it, and sends it as `Idempotency-Key:` header.

## 7. Phase 3 inputs (HTTP + OpenAPI + errors.ts)

In commit order (each its own PR per the user's "small reviewed commits" rule):

1. **`services/api/src/shared/errors.ts`** — add the 47 doc codes (rename/alias
   table in §3.3). Keep the existing v0.1/v0.2 codes as deprecated aliases per
   Standards §4.3.
2. **OpenAPI spec — error envelope** — change to `{ error: { code, message, details, trace_id, docs_url } }` and rename the `Error` schema accordingly. Drop the flatter legacy shape per Standards §4.1 (and the conflict E recommendation).
3. **OpenAPI spec — execution deprecation** — mark every `/execution/*` operation `deprecated: true` with a `description` pointing at the v0.3 equivalent. Add `Deprecation` response-header description on each.
4. **OpenAPI spec — wiki entity path** — rename `/wiki/entity/{entity_id}` → `/wiki/entities/{entity_id}`; rename `GET /wiki/search` → `POST /wiki/search`; add `/wiki/entities/{id}/relationships` and `/wiki/semantic_search`. (Conflict — docs win, per §2.1.)
5. **OpenAPI spec — sources** — add `/sources` family. Owning service: `services/raw` (new HTTP surface; ingestion via `/raw/*` remains).
6. **OpenAPI spec — agent lifecycle** — add `/agents/{id}/{pause,resume}`, `DELETE /agents/{id}`, `POST /agents/{address}/scope` (grant), `/agents/{address}/reputation`, `/agents/{address}/attest`. Owning service: `services/execution` / `@brain/agent` (the renamed layer per Architecture §3.5).
7. **OpenAPI spec — actions or payment-intents** — pending conflict A. If
   `/payment-intents/*` is canonical, add no `/actions/*` family. If `/actions/*`
   is canonical, deprecate `/payment-intents/*`. The SDK can wrap either.
8. **OpenAPI spec — audit** — add `/audit/{event_id}/proof`, rename
   `/audit/event/{event_id}` → `/audit/{event_id}`, rename `/audit/events` →
   `/audit`, rename `/audit/verify` → `/public/audit/verify`,
   `/audit/export` → `/audit/exports` with a `GET .../exports/{id}` companion.
9. **OpenAPI spec — auth** — add `POST /auth/siwx` for the SIWX flow.

Endpoints that are "non-trivial (more than a thin read)" per the prompt and so
need an explicit smaller plan before implementation:

- `/v1/agents/{address}/scope` (writes through to the on-chain `BrainMCPAgentRegistry`)
- `/v1/agents/{address}/reputation` (reputation surface; entirely undefined locally)
- `/v1/agents/{address}/attest` (write of an off-chain attestation)
- `/v1/auth/siwx` (signature verification, JWT issuance, replay protection)
- `/v1/policy/{id}/register` (compose+sign+anchor)

These get their own plans surfaced before any code.

---

## 8. Audit summary — go/no-go on Phase 2

**Go items** (no blocker, ready to scaffold once approved):

- `clients/sdk/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`
- `src/index.ts` skeleton with `Brain` class and the namespace registry
- `src/errors/` with `BrainError` discriminated union for the 47 codes
- `src/http/` with a `fetch`-injectable transport
- `src/idempotency/` (ULID generation + header injection)
- `src/auth/` (apiKey → `Authorization: Bearer`)
- The convenience surface (`ask`, `pay`, `approve`, `reject`, `proof`, `trace`, `snapshot`) as thin wrappers over the namespace surface
- Unit-test scaffolding via undici `MockAgent`

**No-go items** (blocked on the 13 listed conflicts):

| Conflict | Blocks |
| --- | --- |
| A — action vs payment-intent | Every payment-flow method's HTTP route |
| B — decision enum | `ActionDecision` exported type |
| C — capability vocabulary | `agents.register` / `agents.grantScope` |
| D — call style | Every namespaced method's signature |
| E — `trace_id` vs `request_id` | Error envelope mapping |
| F — base URL | `environment` resolution in the constructor |
| G — MCP error code mapping | MCP error surfacing |
| H — MCP endpoint domain | MCP transport target |
| I — auth model | minor — `apiKey` is the documented SDK path; SIWX is additive |
| J — gate checks | minor — server-side, SDK only surfaces error codes |
| K — source types | `Source.type` union |
| L — audit export format | `audit.export(format)` union |
| M — section parallelism | nothing structural; docs hygiene only |

Recommendation: surface conflicts A, B, C, D, F, G, H, K, L to the docs owner
before Phase 2 begins. Conflicts E, I, J are technical (not doc-content) and
can be resolved by the engineering side. Conflict M is a docs-team flag.

End of audit.
