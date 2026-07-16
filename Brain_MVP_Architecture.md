# Brain MVP Architecture

Financial Intelligence Protocol, Minimum Viable Build

Brain Finance Inc. | Delaware | brain.fi v0.4, MVP Blueprint

## Purpose of This Document

This is the MVP architecture: the smallest thing we can build that (1) proves the six-layer protocol works end to end, (2) lands design-partner revenue, and (3) gives a Series A lead enough to underwrite the scale-up round.

Everything that doesn't clear all three bars has been cut. Nothing in here is here because it sounds good, it's here because removing it breaks one of those three bars.

### What Changed In v0.4

v0.4 hardens the Agent layer for production autonomous execution without changing the six-layer model. The protocol shape, the smart-contract set, the §1 principles, and the public API contracts for Raw / Ledger / Wiki / Policy / Audit are unchanged; every v0.4 addition is additive.

- The internal agent library grows from 3 demo agents to **19** (8 business, 8 consumer, 3 agnostic), each declaring an `execution_mode` and gated by a risk tier.
- A multi-agent **router** + two-strategy **intent classifier** select which agent handles a request; an **ActionResolver** selects which action that agent runs, never silently defaulting.
- **Money-movers stay shadowed by default.** Going live is a deliberate, per-agent promotion under strict caps and an allowlisted rail; no agent moves money until promoted.
- The §6 gate gains a **dry-run** mode (the same 23-entry gate trace, persists
  nothing) covering the 13 numbered checks plus 10 hardening additions: `1.5`,
  `3.5`, `5.5`, `6.5`, `6.6`, `6.7`, `7.5`, `8.5`, `9.5`, and `11.5`.
- Internal and external agents share one registry, one ScopeAttestation, one propose path, and one gate. Provenance is a metadata field, never a separate code path.

Detailed §6 dry-run / check-1.5 mechanics and the per-agent promotion gates live in `Brain_Engineering_Standards.md`; the per-phase delivery log lives in `docs/agent-autonomy-v3.md`.

### What Changed In v0.3

v0.3 introduces a Normalized Ledger layer between Raw and Wiki. v0.2 conflated normalized financial truth (transactions, accounts, balances, obligations) with the Wiki memory artifact. That worked for an early demo but blurred the responsibility between "machine-readable financial truth" and "human-readable financial memory." With the Ledger split out:

- Raw remains source evidence.
- Ledger owns machine-readable financial truth, the source from which Policy evaluates and Agents act.
- Wiki becomes derived human-readable memory, regenerable from Ledger and Raw at any time.
- The layer-5 role is named **Agent** to better describe its responsibility (proposing and orchestrating actions, not directly executing them). The rename is conceptual only. The workspace directory stays `services/execution/` (the directory rename is on hold), and back-compat `/execution/*` routes remain alongside `/agents/*`.

The smart contracts, the §1 principles, the audit chain, and the public API contract for Raw / Policy / Audit are unchanged. The Wiki API is preserved but its role in MVP shifts to memory rendering rather than authoritative storage.

## 1. The Protocol in One Page

Brain turns financial activity into memory, memory into intelligence, and intelligence into execution. It does not hold funds. It does not move money directly. It sits between an account holder and their financial world as the structured intelligence layer.

Six layers, each with a public API:

```
┌─────────────────────────────────────────────────────────┐
│ CONSUMERS: Business UI · Consumer app · API partners    │
└───────────────┬─────────────────────────────────────────┘
                │
   ┌────────────▼────────────┐
   │  6. AUDIT               │  Merkle log, on-chain anchor
   └────────────▲────────────┘
   ┌────────────┴────────────┐
   │  5. AGENT               │  Internal/external agents, MCP, PaymentIntent orchestration
   └────────────▲────────────┘
   ┌────────────┴────────────┐
   │  4. POLICY              │  Rules VM, deterministic pre-execution gate, signing
   └────────────▲────────────┘
   ┌────────────┴────────────┐
   │  3. WIKI (memory)       │  Human-readable pages, questions and answers, derived from Ledger
   └────────────▲────────────┘
   ┌────────────┴────────────┐
   │  2. LEDGER (truth)      │  Normalized financial truth (Postgres)
   └────────────▲────────────┘
   ┌────────────┴────────────┐
   │  1. RAW (evidence)      │  Immutable ingestion
   └─────────────────────────┘
```

The data flow is one-way upward except for two controlled write paths: (a) human annotations and agent contributions write into Raw, never directly into Ledger; (b) the Agent layer creates PaymentIntent rows in the Ledger (the only ledger-write path that doesn't originate from a Raw extraction).

Every action produces new Raw evidence, which updates the Ledger, which feeds Wiki memory and Policy evaluation, which gate Agent decisions, every step of which is auditable. The loop is the moat.

The Wiki is a compiled, continuously-updated memory artifact derived from Ledger + Raw, the same pattern as Karpathy's LLM Wiki, but online and multi-tenant. Source immutability means the Ledger and the Wiki can always be re-derived from Raw, which is the property that makes the protocol auditable.

### Core Principle

| Layer  | Owns                                        |
| ------ | ------------------------------------------- |
| Raw    | Source evidence                             |
| Ledger | Machine-readable financial truth            |
| Wiki   | Human-readable financial memory             |
| Policy | Deterministic permission and approval logic |
| Agent  | Proposal/action orchestration               |
| Audit  | Immutable proof of what happened and why    |

## 2. Tech Stack

One stack. Boring on purpose. Every choice here is a default that gets the team to shipping fast and lets the interesting engineering happen in the domain layer, not the infrastructure.

What's deliberately not in the stack: graph databases, Kafka, Kubernetes, a separate search service, a separate vector DB, a workflow engine (Temporal/Airflow), a feature flag service, Terraform Cloud. We will need some of these later. Not now.

## 3. The Six Layers

Each layer has a minimal public API and a minimal data model. Nothing else.

### Layer 1: Raw (Ingestion)

What it does. Accept financial evidence from any source, store it immutably, fingerprint it, make it retrievable by hash.

Data model (Postgres).

```sql
-- The manifest. One row per ingested artifact.
raw_artifacts (
  id            TEXT PK,                 -- raw_<ulid>
  tenant_id     TEXT NOT NULL,
  sha256        BYTEA NOT NULL,          -- content address
  source_type   TEXT NOT NULL,           -- plaid | erp_netsuite | email | upload | chain_evm | ...
  source_ref    JSONB,                   -- source-specific identifiers
  blob_uri      TEXT NOT NULL,
  mime_type     TEXT,
  bytes         BIGINT,
  ingested_at   TIMESTAMPTZ DEFAULT now(),
  tombstoned_at TIMESTAMPTZ,             -- deletion is a tombstone, never a mutation
  UNIQUE (tenant_id, sha256)
)

-- Parser output. One row per (artifact, parser_version).
raw_parsed (
  id              TEXT PK,
  raw_artifact_id TEXT REFERENCES raw_artifacts(id),
  parser          TEXT NOT NULL,         -- plaid_tx_v1 | pdf_ocr_v2 | ...
  parser_version  TEXT NOT NULL,
  extracted       JSONB NOT NULL,        -- normalized output
  confidence      REAL,                  -- 0.0 to 1.0 where applicable
  extracted_at    TIMESTAMPTZ DEFAULT now()
)
```

Public API.

```
POST /v1/raw/ingest                upload or URL; returns {raw_id, sha256}
POST /v1/raw/webhooks/{provider}   Plaid, Stripe, generic HMAC
GET  /v1/raw/{raw_id}              short-lived signed URL
GET  /v1/raw/{raw_id}/parsed       parsed output for all parser versions
DELETE /v1/raw/{raw_id}            writes tombstone, does not mutate
```

MVP scope. Five source adapters plus one agent-contribution path. The adapters are Plaid (banking), a generic CSV/PDF upload endpoint, NetSuite (most-used ERP in mid-market), Gmail OAuth (invoice capture), and an EVM chain adapter (Alchemy). That covers the finance team's top sources. In addition, a sixth source_type value, agent_contributed, accepts artifacts pushed by authorized external AI agents (transcripts, documents, structured observations). Agent contributions are content-addressed like any other Raw artifact, attributed to the agent's on-chain registration record in BrainMCPAgentRegistry, and carry the agent's signature as part of their provenance chain. Other source-specific adapters (Slack, Teams, non-EVM chains, custom tenant sources via BYOS) are post-MVP.

Agent contribution governance. An external agent can only contribute to Raw if its tenant's registration record in BrainMCPAgentRegistry explicitly grants the raw:write scope. The tenant authorizes this scope at agent registration time with an EIP-712 signature. Revocation is immediate and on-chain. Agent-contributed artifacts are filtered from standard extraction pipelines until the tenant confirms the agent is trusted (default trust level: quarantine on first N contributions, auto-approve after). This is what keeps agent contributions from polluting the Ledger.

What Raw must not do. Raw must not store financial conclusions as authoritative facts. A receipt is a Raw artifact; the obligation it implies is a Ledger row derived from extraction. The two never share a column. Mutation of the original ingested payload is forbidden, only tombstoning and parser-output re-derivation are allowed.

What's NOT in MVP. Real-time streaming. Slack/Teams adapters (though agents can contribute transcripts via the agent path). Non-EVM chains. Automatic redaction tooling (manual redaction endpoint only). Multi-region replication of the raw blob store (single region, backup only). A generic Bring-Your-Own-Source (BYOS) adapter framework letting developers write their own tenant-facing ingestion connectors. That capability is explicitly deferred to post-MVP and tracked separately.

### Layer 2: Normalized Ledger (Truth)

What it does. Maintain a normalized, machine-readable model of every financial fact that matters: accounts, balances, transactions, counterparties, obligations, invoices, documents, categories, transfers, payment intents, and reconciliation matches. Every Ledger row is derived from Raw evidence (or, in the case of PaymentIntent, from an agent proposal that itself produced a Raw artifact). The Ledger is the source of truth that Policy evaluates and Agents act against.

Why Ledger is its own layer. Wiki is human-readable memory. Policy needs deterministic, queryable financial state. Agents need machine-checkable preconditions. None of these belong in a memory artifact. Splitting Ledger out makes the contract explicit: if it's a fact about your money, it lives here.

Data model (Postgres). Every Ledger entity carries `id`, `owner_id` (tenant), `created_at`, `updated_at`, `status`, `source_ids` (array of `raw_artifacts` ids), `evidence_ids` (array of `raw_parsed` ids that produced or refined this row), `provenance`, and a `confidence` real where extraction or matching is probabilistic.

Eleven entities are mandatory at MVP:

```sql
-- 1. Account: a bank account, card, loan, or on-chain address.
ledger_accounts (
  id, owner_id, institution, external_account_id, account_type,
  name, currency, current_balance, available_balance, status,
  source_ids[], evidence_ids[], created_at, updated_at, provenance, confidence
)

-- 2. Balance: a point-in-time snapshot. Account holds the latest;
--    balance rows hold history (for "what was my balance on March 14?").
ledger_balances (
  id, account_id, as_of, current_balance, available_balance,
  pending_balance, currency,
  source_ids[], evidence_ids[], created_at, provenance, confidence
)

-- 3. Transaction: a single money-movement event.
ledger_transactions (
  id, owner_id, account_id, external_transaction_id,
  amount, currency,
  direction,             -- inflow | outflow | transfer | adjustment
  transaction_date, posted_date,
  counterparty_id, category_id,
  status,                -- pending | posted | cleared | failed | reversed | disputed
  description_raw, description_normalized,
  source_ids[], evidence_ids[],
  reconciliation_status, -- unreconciled | matched | partial | disputed
  created_at, updated_at, provenance, confidence
)

-- 4. Counterparty: a party the tenant transacts with.
ledger_counterparties (
  id, owner_id, name, normalized_name,
  type,                  -- merchant | vendor | customer | employer | bank | wallet | exchange | tax_authority | other
  risk_level,            -- low | medium | high | sanctioned
  verified_status,       -- unverified | self_attested | document_verified | sanctions_cleared
  aliases[], linked_accounts[],
  source_ids[], evidence_ids[], created_at, updated_at, provenance, confidence
)

-- 5. Obligation: an amount owed to or by the tenant.
ledger_obligations (
  id, owner_id,
  type,                  -- bill | invoice | subscription | loan | rent | payroll | tax | card_statement | other
  counterparty_id,
  amount_due, minimum_due, currency,
  due_date, recurrence,
  status,                -- upcoming | due | paid | overdue | cancelled | disputed
  linked_transaction_ids[], evidence_ids[],
  created_at, updated_at, provenance, confidence
)

-- 6. Document: a structured document derived from a Raw artifact.
ledger_documents (
  id, owner_id,
  document_type,         -- invoice | receipt | bank_statement | card_statement | contract | payroll | tax | other
  source_uri, extracted_fields,
  linked_account_ids[], linked_transaction_ids[], linked_obligation_ids[],
  source_ids[], evidence_ids[], confidence_score,
  created_at, updated_at, provenance
)

-- 7. Category: a tenant-scoped categorization label.
ledger_categories (
  id, owner_id, name, parent_id, kind, -- expense | income | transfer | other
  created_at, updated_at
)

-- 8. Transfer: an internal transfer between two of the tenant's own accounts.
--    Pairs two transaction rows.
ledger_transfers (
  id, owner_id, from_account_id, to_account_id,
  from_transaction_id, to_transaction_id,
  amount, currency, transfer_date, status,
  source_ids[], evidence_ids[], created_at, updated_at
)

-- 9. Invoice: a structured invoice (issued or received).
ledger_invoices (
  id, owner_id, invoice_number, counterparty_id,
  amount_due, amount_paid, currency,
  issue_date, due_date, status,
  linked_document_ids[], linked_transaction_ids[],
  source_ids[], evidence_ids[], created_at, updated_at
)

-- 10. PaymentIntent: an Agent-proposed financial action awaiting execution.
--     Lifecycle is owned by the Agent layer; the row lives in Ledger because
--     it IS a financial fact you query like any other Ledger row.
ledger_payment_intents (
  id, owner_id, created_by_agent_id,
  action_type,           -- ach_outbound | ach_inbound | wire | onchain_transfer | erp_writeback | card_payment | other
  source_account_id, destination_counterparty_id,
  amount, currency,
  obligation_id, invoice_id,
  status,                -- proposed | pending_approval | approved | paused | rejected | executed | failed | cancelled
  policy_decision_id, approval_ids[], execution_receipt_ids[],
  evidence_ids[], created_at, updated_at
)

-- 11. ReconciliationMatch: a match between two Ledger entities.
ledger_reconciliation_matches (
  id, owner_id,
  match_type,            -- transaction_receipt | invoice_payment | statement_balance | wallet_transfer | payroll_bank_debit | subscription_charge
  left_entity_type, left_entity_id,
  right_entity_type, right_entity_id,
  confidence_score,
  status,                -- unmatched | matched | partially_matched | duplicate_possible | disputed | cleared | failed | reversed
  evidence_ids[], explanation,
  created_at, updated_at
)
```

Every Ledger row carries `provenance` (extracted | inferred | ambiguous | human_confirmed | agent_contributed) and `confidence` (0.0–1.0). Agent-contributed rows start at confidence ceiling 0.5 per the §3.2 governance carry-forward rule.

Public API.

```
GET  /v1/ledger/accounts                       list accounts
GET  /v1/ledger/accounts/{id}                  account detail + balance history
GET  /v1/ledger/balances                       point-in-time balances
GET  /v1/ledger/transactions                   filter, paginate
GET  /v1/ledger/transactions/{id}              transaction detail
GET  /v1/ledger/counterparties                 list/search counterparties
GET  /v1/ledger/obligations                    upcoming/due/overdue obligations
GET  /v1/ledger/invoices                       list/filter invoices
POST /v1/ledger/normalize                      idempotent re-normalization of an artifact
POST /v1/ledger/reconcile                      run reconciliation engine

# PaymentIntents are a Ledger entity but life-cycle endpoints live in the Agent group.
```

What Ledger must not do. Ledger must not contain freeform Wiki summaries as authoritative data. Ledger rows are validated against typed JSON Schemas; prose belongs in Wiki pages.

MVP scope. The eleven entities above. Other ledger entities (positions, securities, FX rates, cost-basis lots) are post-MVP.

Reconciliation coverage at v0.4 ship. The reconciliation engine is wired end-to-end and runs all 7 registered matchers, all now concrete implementations (`invoice_payment`, `transaction_receipt`, `statement_balance`, `wallet_transfer`, `payroll_bank_debit`, `subscription_charge`, `card_charge`) with unit + property test coverage.

### Layer 3: Wiki (Memory)

What it does. Maintain human-readable memory over the Ledger and Raw layers: searchable pages, narrative summaries, and a natural-language question-answering endpoint. Wiki pages are derived artifacts, they regenerate from Ledger + Raw on demand and on schedule.

Why Wiki is downstream of Ledger. Wiki text is for humans; Ledger is for machines. If you ask "What was my biggest expense last month?" the answer comes from Ledger (transactions table) with the prose composed by Wiki. If a Wiki page and the Ledger disagree, the Ledger wins, and the Wiki is regenerated.

Data model (Postgres).

```sql
-- A rendered page. Regenerable from Ledger + Raw at any time.
wiki_pages (
  id              TEXT PK,                -- wpg_<ulid>
  tenant_id       TEXT NOT NULL,
  page_type       TEXT NOT NULL,          -- account | counterparty | obligation | invoice | agent | policy | monthly_summary | cash_flow
  subject_id      TEXT,                   -- ledger row this page describes (NULL for cross-cutting summaries)
  slug            TEXT NOT NULL,          -- /accounts/{id}, /monthly-summaries/{month}, ...
  body_md         TEXT NOT NULL,          -- markdown; sections per below
  body_embedding  vector(1536),
  rendered_at     TIMESTAMPTZ NOT NULL,
  source_revision TEXT NOT NULL,          -- ledger checksum at render time
  UNIQUE (tenant_id, slug)
)

-- A bitemporal pointer to a Ledger row, so historic Wiki can "show what we knew."
wiki_snapshots (
  id              TEXT PK,
  tenant_id       TEXT NOT NULL,
  page_id         TEXT REFERENCES wiki_pages(id),
  ledger_row_type TEXT NOT NULL,          -- ledger_transactions | ledger_accounts | ...
  ledger_row_id   TEXT NOT NULL,
  valid_from      TIMESTAMPTZ NOT NULL,
  valid_to        TIMESTAMPTZ              -- NULL = currently shown
)

-- Annotations layered on top of Ledger rows. Stored in Wiki because they are
-- human-authored memory, not machine-derived truth. They affect Ledger only via
-- /wiki/annotate, which writes a Raw artifact and a derived Ledger row.
wiki_annotations (
  id          TEXT PK,
  tenant_id   TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  body        TEXT,
  authored_by TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
)
```

Public API.

```
GET  /v1/memory/pages                       list/search pages
GET  /v1/memory/pages/{slug_or_id}          a single page
POST /v1/memory/regenerate                  regenerate a page from current Ledger
GET  /v1/memory/search                      semantic + lexical search across pages
POST /v1/wiki/question                      NL question → grounded answer + evidence path
POST /v1/wiki/annotate                      human correction; writes through Raw
GET  /v1/wiki/schema                        page-type schemas
```

The /question endpoint is where Claude sits in the hot path. It takes a natural-language question, consults Ledger for facts and Wiki pages for context, executes a small number of SQL queries, and composes an answer with evidence path. Crucially, the LLM grounds in **Ledger rows**, not in Wiki text, Wiki provides recall and retrieval scaffolding, but the cited facts come from the Ledger. This is Brain's "feel": ask anything about your money and get a grounded answer with receipts.

Every wiki page should include the following sections (rendered as markdown):

- **Current Truth**: the live Ledger summary
- **Key Linked Entities**: counterparties, accounts, obligations
- **Recent Activity**: last N transactions/events
- **Open Questions / Missing Evidence**: what we haven't reconciled
- **Risk Notes**: sanctions hits, anomaly flags, low-balance warnings
- **Timeline**: bitemporal view of changes
- **Evidence Links**: every fact's source `raw_parsed` id

What Wiki must not do. Wiki text is never the source of truth for balances, obligations, transactions, or permissions. Policy never reads from Wiki. Execution never reads from Wiki. Agents may read Wiki for narrative recall, but every machine-checkable precondition comes from the Ledger.

MVP scope. Eight page types: `/accounts/{account_id}`, `/counterparties/{counterparty_id}`, `/obligations/{obligation_id}`, `/invoices/{invoice_id}`, `/agents/{agent_id}`, `/policies/{policy_id}`, `/monthly-summaries/{YYYY-MM}`, `/cash-flow/{period}`. Anything else is post-MVP.

Page-generator coverage at v0.4 ship. All eight generators are concrete implementations (`account`, `counterparty`, `obligation`, `monthly_summary`, `invoice`, `agent`, `policy`, `cash_flow`). The `WikiPageService.regenerate` path dispatches to the right generator on every call.

What's NOT in MVP. A graph database. Contradiction detection beyond exact-match. Automatic entity resolution across tenants. A natural-language write path (annotations are structured, not conversational). Cross-tenant agent memory sharing.

### Layer 4: Policy (Governance)

What it does. Encode what a tenant allows as a versioned, signable artifact. Evaluate proposed actions against the active policy and the **current Ledger state**. Return allow / confirm / reject with a trace and a `PolicyDecision` record that downstream layers consume as proof.

Key change from v0.2. Policy evaluators read Ledger state directly (current balance, counterparty verified status, obligation due, etc.) rather than against an opaque action object. The 23-entry pre-execution gate (defined in §6 of Engineering Standards) runs deterministic Ledger checks before any payment can execute.

v0.4 gate additions. The gate gains a **dry-run** mode. The same 23-entry trace runs against the same Ledger state, but it persists no `policy_decisions` row and emits no audit event (its trace is cached ~60 s for the run path). The agent run pipeline dry-runs before proposing so a doomed proposal never reaches the live path. The gate now records 13 numbered checks plus 10 hardening additions: **1.5** runtime behavior pinning, **3.5** on-chain settlement permission, **5.5** agent-counterparty attestation, **6.5** x402 payment context, **6.6** escrow state binding, **6.7** obligation direction, **7.5** ledger-state binding, **8.5** micropayment window cap, **9.5** evidence semantics, and **11.5** duplicate-payment hard reject. Both modes remain a single evaluator. Live and dry-run share the same gate code (INV: one evaluator).

Data model.

```sql
policies (
  id, tenant_id, version, content, content_hash,
  signers, activated_at, deactivated_at,
  state                     -- draft | pending_signatures | active | deactivated | cancelled | expired
)

policy_decisions (
  id, tenant_id, policy_id, policy_version,
  subject_type,              -- payment_intent | wiki_question | agent_action
  subject_id,
  outcome,                   -- allow | confirm | reject
  matched_rule_id,
  required_approvers[],
  ledger_snapshot_hash,      -- hash of the Ledger state used for evaluation
  trace JSONB,
  decided_at TIMESTAMPTZ
)
```

Policy DSL, MVP primitive set.

```yaml
rules:
  - id: <string>
    applies_to: [outbound_payment | inbound_payment | ledger_write | onchain_tx | any]
    when:
      counterparty.in: <list_ref> # vendors.trusted, etc.
      counterparty.not_in: <list_ref>
      counterparty.verified: true|false
      amount.lte: { currency, value }
      amount.gt: { currency, value }
      account.balance.gte: { currency, value }
      agent.role: <role>
      time_window: <cron_expr>
    require: [single_signer | <role>_approval | <role>_and_<role>]
    execute: auto | confirm | reject
```

Eight primitives in MVP (counterparty.in/not_in/verified, amount.lte/gt, account.balance.gte, agent.role, time_window). Jurisdictional rules, delegation chains, and more exotic constructs are post-MVP.

Public API.

```
GET  /v1/policy/{tenant_id}                 active policy
GET  /v1/policy/{tenant_id}/versions        version history
POST /v1/policy/{tenant_id}/compose         new policy → returns signing payload
POST /v1/policy/{tenant_id}/sign            submit signatures
POST /v1/policy/{tenant_id}/evaluate        {subject} → {decision, trace, required_approvers}
POST /v1/policy/{tenant_id}/simulate        replay against historical version
GET  /v1/policy/decisions/{id}              fetch a stored PolicyDecision
```

What Policy must not do. Policy never executes. Policy never mutates Ledger or Audit. Policy reads Ledger and writes one row to `policy_decisions`. Everything else is downstream.

Signing. EIP-712 typed-data signatures. Enterprise tier gets on-chain policy registration via BrainPolicyRegistry. SMB tier gets off-chain signed policies stored in Postgres. Same primitive, different durability surface.

MVP scope. Business policies only. Consumer "autonomy level" (Notify / Confirm / Execute) is a single built-in rule template, not a DSL composition.

What's NOT in MVP. Multi-jurisdictional rules. Complex delegation chains. Policy diffing/merging. Policy linting.

### Layer 5: Agent (Action Orchestration)

What it does. Run specialized agents that read the Ledger, propose actions, pass them through Policy, orchestrate execution of approved actions through external rails, and log everything. The Agent layer **proposes and orchestrates**: it does not execute financial actions directly. (Implemented by the `services/execution/` workspace. The directory rename to an Agent-named folder is on hold; back-compat `/execution/*` routes remain alongside `/agents/*`.) Execution happens through provider rails (Plaid Transfer, NetSuite SuiteTalk, BrainSmartAccount on-chain) under a deterministic gate.

Agents in MVP. Nineteen, in one shared library: 8 business, 8 consumer, 3 agnostic. The original demo agents (reconciliation, payment, fraud-anomaly) are still here; the library extends them rather than replacing them.

Each agent declares an `execution_mode`. One of `execute | propose | confirm | notify_only | reject`. And carries a **risk tier**. The tier is the hard gate on autonomy: only low-risk agents can resolve to `execute`; high-risk agents (`compliance`, `vendor_risk`) are pinned at `confirm`/`reject` and declare no `default_action`; money-movers (`treasury`, `payment`, `savings`, `bill_management`) are **shadowed by default**. A financial proposal terminates as `shadow_completed` and moves no money until an operator promotes that specific agent under strict caps and an allowlisted rail.

- **Business (8):** `cash_forecast`, `collections`, `compliance` (high-risk), `dispute`, `payment` (money-mover, shadowed), `revenue_intel`, `treasury` (money-mover, shadowed), `vendor_risk` (high-risk).
- **Consumer (8):** `bill_management` (money-mover, shadowed), `debt_optimization`, `financial_health`, `personal_budget`, `purchase_advisor`, `savings` (money-mover, shadowed), `tax_prep`, `travel_finance`.
- **Agnostic (3):** `reconciliation` (match/notify, no money authority), `fraud_anomaly` (notify-only), `subscription`.

Reconciliation, fraud-anomaly, and payment still cover the original demo and exercise the full six-layer stack end-to-end; the wider library proves the substrate generalizes across business and consumer surfaces under one set of rules. FX, payroll, tax-filing, and on-chain yield remain the post-MVP frontier.

Routing. A request does not name an agent directly. A multi-agent **router** selects the handling agent using category-aware routing (the tenant's `category` narrows the candidate set to business vs. consumer agents), backed by a two-strategy **intent classifier** (a deterministic keyword strategy and an embedding strategy, selectable per deployment). Within the selected agent, an **ActionResolver** picks the action: explicit `requested_action` → `event_action_map` → `intent_action_map` → an opt-in `default_action`. It never silently falls back to the first declared action; an unresolved request persists as `missing_action`. Money-movers and high-risk agents declare **no** `default_action`. The routing decision and its structured reason are persisted (`agent_routing_decisions`) and surfaced via `GET /v1/agents/runs/{run_id}/why`.

Provenance. Internal and external agents are the same machinery. One registry (`BrainMCPAgentRegistry`), one EIP-712 ScopeAttestation, one propose path, one §6 gate. Provenance (`internal` vs. `external`) is a metadata field on the agent record and the run, never a separate code path. There is no privileged "BrainNativeAgent" that skips the gate; an internal agent earns no authority an external agent couldn't be granted. This is what keeps Brain a protocol rather than a product with a plugin slot.

Data model.

```sql
agents (
  id, tenant_id, kind,             -- internal | external
  role, display_name,
  scope_hash, onchain_address,
  state,                            -- pending_onchain | active | revoked | failed
  registered_tx, registered_at, created_at
)

-- A non-payment proposal. Used by reconciliation/anomaly agents and any
-- non-financial action.
proposals (
  id, tenant_id, proposing_agent,
  action JSONB, policy_version, policy_decision_id,
  status,                           -- pending | approved | rejected | executed | failed
  approvers_signed[], created_at
)

-- The execution attempt for either a Proposal or a PaymentIntent.
executions (
  id, tenant_id, proposal_id, payment_intent_id,
  rail,                             -- bank_ach | erp_writeback | onchain_base | notification
  rail_receipt JSONB,
  status,                           -- dispatched | in_flight | completed | failed
  idempotency_key, started_at, completed_at
)
```

Public API.

```
# Agents (formerly /execution/agents/*)
GET  /v1/agents                                  list configured agents
GET  /v1/agents/{agent_id}                       agent config + on-chain registration record
POST /v1/agents/{agent_id}/propose               agent proposes a non-financial action
POST /v1/agents/{agent_id}/actions               list of recent actions/proposals
GET  /v1/agents/{agent_id}/actions/{action_id}   detail
POST /v1/agents/register                         register external agent; returns on-chain attestation

# Agent routing + runs (v0.4)
POST /v1/agents/route                            routing decision only (no run)
POST /v1/agents/run                              route → resolve action → dry-run gate → persist → propose
POST /v1/agents/events                           enqueue an event-driven route/run job
GET  /v1/agents/runs                             run history
GET  /v1/agents/runs/{run_id}                    run detail
GET  /v1/agents/runs/{run_id}/why                structured reason + (redacted) trace + gate trace + receipt
GET  /v1/agents/routing-decisions/{id}           routing decision detail

# Kill-switch (v0.4)
POST /v1/agents/{agent_id}/halt                  pause in-flight intents + quarantine the agent
POST /v1/agents/halt-category                    emergency-stop a whole category

# PaymentIntent lifecycle (financial actions; sit in Ledger but are governed by Agent)
POST /v1/payment-intents                         agent creates intent → returns proposed PaymentIntent
GET  /v1/payment-intents/{id}                    detail with PolicyDecision + audit trail
POST /v1/payment-intents/{id}/approve            human approval for `confirm` intents
POST /v1/payment-intents/{id}/reject             human/agent rejection
POST /v1/payment-intents/{id}/execute            execute approved intent through rail
POST /v1/payment-intents/{id}/pause              pause an approved intent (v0.4)
POST /v1/payment-intents/{id}/resume             resume. Re-runs the live §6 gate (v0.4)
GET  /v1/payment-intents/{id}/replay-investigation  typed forensic record (v0.4)

# MCP, external agent surface
POST /v1/agents/mcp                              MCP JSON-RPC entry (replaces /execution/mcp)
```

Backward-compat note. The v0.2 routes `/execution/propose`, `/execution/{id}`, `/execution/approve`, `/execution/escalate`, `/execution/agents*`, `/execution/mcp` are preserved in MVP with deprecation headers and remain functional for the duration of the v0.3 transition. The one exception is `/execution/execute`, which is **disabled**: it dispatched money through a rail with no §6 pre-execution gate, so it now returns `422 gate_no_policy_decision`. Execute money movement via `/payment-intents/{id}/execute` (or `/actions/{id}/execute`), which run the gate. New integrations should use the `/agents/*` and `/payment-intents/*` routes above.

MCP interface. External agents (tenant-authorized) connect via MCP and get bidirectional access to Brain: they can read Ledger and Wiki, contribute Raw artifacts (transcripts, documents, structured observations) that flow through the extraction pipeline into Ledger rows with `provenance=agent_contributed`, and propose actions that pass through Policy and Audit like any internal agent would. Every authorized third-party agent is registered on-chain in BrainMCPAgentRegistry with its scope attestation. The scope explicitly enumerates which of these three capabilities (read, contribute, propose) the tenant has granted. This is one of Brain's category-defining moves: shipping a bidirectional agent-contribution protocol in MVP, with cryptographic attribution of every contribution, signals that the agent-economy thesis is real and that Brain is positioned as the substrate agents route through.

MCP implementation (v0.3). The `@brain/mcp` workspace ships a JSON-RPC 2.0 dispatcher mounted at `POST /v1/agents/mcp`, single-shot HTTP transport (one request, one response, SSE / streamable transports are post-MVP behind a feature flag). The surface is:

- **10 tools** across four capability groups: Ledger read (`ledger.account.get`, `ledger.accounts.list`, `ledger.transactions.list`, `ledger.obligations.list`, `ledger.counterparties.list`), Wiki read (`wiki.question`, `wiki.page.get`), Raw contribute (`raw.contribute`), Payment-intent propose (`payment_intent.propose`, note: no `.execute`; the §6 23-entry gate is the only execution path), and Agent action propose (`agent.action.propose`).
- **5 resource templates** addressable by `brain://` URIs: ledger accounts, ledger transactions, ledger payment-intents, wiki pages, raw evidence.
- **5 canned prompts** for the most common agent loops: cash flow summary, bills due, spending change, invoice status, subscriptions.

Auth chain. The Fastify `authPlugin` validates the JWT and resolves the principal (tenant + scopes) upstream. The MCP layer adds three checks before any method dispatch: (a) the agent record in `agents` is `active`; (b) the JWT's `scope_hash` claim matches the on-chain hash registered in `BrainMCPAgentRegistry` (verified once and cached for 60 s per agent); (c) JWT tenant equals agent tenant. Failures map to JSON-RPC error codes -32001..-32005. Tool calls then enforce per-call scopes (`ledger:read`, `wiki:read`, `raw:write`, `payment_intent:propose`, `execution:propose`).

Audit. Every successful `tools/call` and `resources/read` emits an outer `agent.mcp.tool_called` audit event. Tools that mutate state (e.g. `raw.contribute`, `payment_intent.propose`) emit their own inner audit events through the same `LedgerService` / `PaymentIntentService` methods the HTTP API uses, so policy gating + audit emission are identical between the HTTP and MCP paths.

See `docs/mcp-architecture.md` for the full surface map, error-code table, and capability-negotiation details. Source lives under `services/mcp/src/`; the boot site wires it onto the existing Fastify app via the `registerMcp` callback on `buildExecutionApp` (no workspace cycle, `services/execution` stays unaware of `@brain/mcp`).

What Agent must not do. Agents must not mutate Raw, Ledger, Policy, or Audit stores directly. Every Ledger write that originates from agent reasoning (e.g. a `ReconciliationMatch` insert) goes through `LedgerService` methods that emit audit events. Every payment goes through `PaymentIntent` with a `PolicyDecision` and the §6-of-standards pre-execution gate. No financial execution path bypasses Policy.

Rails in MVP. Three rails are first-class. (1) ACH via the tenant's existing bank API (Plaid Transfer as a fallback where direct bank integration is not available). (2) ERP writeback to NetSuite. (3) On-chain execution to Base Sepolia through a directly called BrainSmartAccount session key and policy guard (see contracts). Card rails, wire rails, international rails, and Base mainnet are post-MVP or pre-mainnet gated. Rail receipts are **typed** per rail (`ach` / `wire` / `erp` / `onchain`); the audit-after step refuses to commit a receipt that fails its schema, and `GET /v1/payment-intents/{id}/replay-investigation` returns the full forensic bundle (intent + executions + rail receipts + linking ids).

Containment (v0.4). Autonomy is reversible at three scopes. A single approved intent can be **paused** (`/pause`) and **resumed** (`/resume` re-runs the live §6 gate before continuing). The rail dispatcher aborts if it sees `paused`. An agent can be **halted** (`/halt`): its in-flight intents pause and the agent moves to `quarantined`. A whole **category** can be emergency-stopped (`/halt-category`). On-chain, `BrainSmartAccount.pauseSessionKey(holder)` disables execution while preserving the key record, window spend, limits, and metadata. Distinct from `revokeSessionKey`, which is permanent removal. Per-task minimum-privilege session keys (`derivePerTaskSessionKey`) bound a one-time child key to the exact counterparty, exact amount, and a short TTL.

Shadow by default. Every money-mover starts shadowed: its financial proposal runs the full pipeline (route → resolve → dry-run gate → persist → propose) but terminates as `shadow_completed` and moves no money. Promotion to live money movement is a deliberate, per-agent operator action (`StaticPromotionPolicy`) gated by strict caps and an allowlisted rail. No agent in this build moves money until promoted.

### Layer 6: Audit (Proof)

What it does. Append-only log of every meaningful event across all five lower layers. Tamper-evident via Merkle anchoring. Exportable in auditor-friendly formats.

Every material state change must create an audit event. That includes Ledger writes, PolicyDecision creation, PaymentIntent state transitions, agent proposals/approvals/rejections, execution attempts and results, and every wiki annotation that writes through to Ledger. The audit log is what proves the §6.1 invariant: "if it is not in the log, it did not happen."

Data model.

```sql
audit_events (
  id, tenant_id,
  layer,                     -- raw | ledger | wiki | policy | agent | audit
  actor,                     -- agent ID, human user ID, api_partner ID
  action,                    -- ledger.transaction.posted | policy.decision.recorded | payment_intent.executed | ...
  inputs JSONB,              -- hashes and evidence refs, not full content
  outputs JSONB,
  policy_version, policy_decision_id,
  before_state JSONB,        -- where applicable
  after_state JSONB,         -- where applicable
  event_hash BYTEA,          -- deterministic hash of canonical serialization
  prev_event_hash BYTEA,     -- hash chain per tenant
  created_at TIMESTAMPTZ DEFAULT now()
)

audit_anchors (
  id, tenant_id, merkle_root, event_count,
  period_start, period_end,
  onchain_tx_hash, onchain_block_number,
  created_at
)
```

Public API.

```
GET  /v1/audit/events                                query by filter
GET  /v1/audit/events/{id}                           record + inclusion proof
GET  /v1/audit/entity/{entityType}/{entityId}        every event touching a Ledger row
POST /v1/audit/export                                {format, range} → job
GET  /v1/audit/anchor/latest                         latest on-chain anchor
GET  /v1/audit/verify                                verify inclusion against on-chain root (public, no auth)
```

What Audit must not do. Audit rows are append-only. There is no UPDATE path, no DELETE path. Anchors, once published, refuse re-publication of the same root.

Anchoring cadence in MVP. Hourly for all tenants. Per-event anchoring is a post-MVP enterprise feature.

Export formats in MVP. JSONL and CSV. SOX-ready PDF is post-MVP, JSONL + a schema doc is sufficient for most audit and regulator workflows.

## 4. Smart Contracts

Six contracts are deployed on Base Sepolia today. They are unaudited and not a
Base mainnet execution environment. Mainnet deployment is pending external audit,
bytecode verification, and operator attestation.

### BrainAuditAnchor

Publishes per-tenant Merkle roots to Base. Anyone can verify that an audit record was included in a root that was published at a given block height, without trusting Brain.

```solidity
contract BrainAuditAnchor {
  event AnchorPublished(
    bytes32 indexed tenantId,
    bytes32 root,
    uint256 eventCount,
    uint256 periodStart,
    uint256 periodEnd
  );

  function anchor(
    bytes32 tenantId,
    bytes32 root,
    uint256 eventCount,
    uint256 periodStart,
    uint256 periodEnd
  ) external onlyPublisher;

  function verifyInclusion(
    bytes32 root,
    bytes32 leaf,
    bytes32[] calldata proof
  ) external pure returns (bool);

  function latestAnchor(bytes32 tenantId)
    external view returns (bytes32 root, uint256 blockNumber);
}
```

The current Base Sepolia publisher is a single EOA. A Safe multisig publisher is
a pre-mainnet TODO. Contract upgrade posture is finalized as part of audit.

### BrainPolicyRegistry

Registers the hash and signer set of enterprise policies at the time they go into force. Lets a third party verify which policy was actually active on a given date, independent of Brain's database.

```solidity
contract BrainPolicyRegistry {
  event PolicyRegistered(
    bytes32 indexed tenantId,
    uint256 indexed version,
    bytes32 policyHash,
    address[] signers,
    uint256 activatedAt
  );

  function registerPolicy(
    bytes32 tenantId,
    uint256 version,
    bytes32 policyHash,
    address[] calldata signers,
    bytes[] calldata signatures
  ) external;

  function getPolicy(bytes32 tenantId, uint256 version)
    external view returns (bytes32 hash, address[] memory signers, uint256 activatedAt);
}
```

Enterprise-tier tenants only. SMB/consumer policies stay off-chain.

### BrainSmartAccount

The on-chain execution pattern for the payment-agent. BrainSmartAccount is a
directly called session-key account owned by the tenant, with a revocable session
key granted to Brain's payment-agent. Every on-chain action is pre-checked
against the policy fingerprint in BrainPolicyRegistry and emits an event
consumable by the Audit layer.

```solidity
contract BrainSmartAccount {
  // Session key module: grants scoped, time-bound keys to Brain agents
  struct SessionKey {
    address holder;            // Brain's agent address
    uint256 validAfter;
    uint256 validUntil;
    address[] allowedTargets;  // contracts the key can call
    bytes4[] allowedSelectors; // function selectors it can invoke
    uint256 maxPerTx;          // per-transaction amount cap
    uint256 maxPerPeriod;      // cumulative cap per period
    bytes32 policyVersion;     // must match BrainPolicyRegistry active version
  }

  event SessionKeyGranted(address indexed holder, bytes32 policyVersion, uint256 validUntil);
  event SessionKeyRevoked(address indexed holder);
  event AgentActionExecuted(
    bytes32 indexed tenantId,
    bytes32 indexed agentId,
    bytes32 policyVersion,
    address target,
    bytes4 selector,
    uint256 amount,
    bytes32 calldataHash
  );

  function grantSessionKey(SessionKey calldata key) external onlyOwner;
  function revokeSessionKey(address holder) external onlyOwner;
  function executeViaSessionKey(
    address target,
    uint256 value,
    bytes calldata data
  ) external returns (bytes memory result);
}
```

The tenant's root key can revoke any session key instantly. Brain's agent cannot execute outside the session key's declared scope under any circumstance. This is the pattern that makes on-chain agent execution acceptable to both security teams and regulators.

### BrainMCPAgentRegistry

Public registry of third-party agents authorized to connect to a tenant's MCP interface. On-chain scope attestation means any observer can verify which agents have which permissions without trusting Brain's off-chain records.

```solidity
contract BrainMCPAgentRegistry {
  struct AgentRegistration {
    bytes32 agentId;       // unique agent identifier
    address agentAddress;  // agent's signing key
    bytes32 tenantId;      // authorizing tenant
    bytes32 scopeHash;     // hash of canonical scope document
    uint256 registeredAt;
    uint256 revokedAt;     // 0 if active
  }

  event AgentRegistered(
    bytes32 indexed agentId,
    address indexed agentAddress,
    bytes32 indexed tenantId,
    bytes32 scopeHash
  );
  event AgentRevoked(bytes32 indexed agentId, bytes32 indexed tenantId);

  function registerAgent(
    bytes32 agentId,
    address agentAddress,
    bytes32 tenantId,
    bytes32 scopeHash,
    bytes calldata tenantSignature // EIP-712 signature from tenant authorizing this scope
  ) external;

  function revokeAgent(bytes32 agentId, bytes calldata tenantSignature) external;
  function isAuthorized(bytes32 agentId, bytes32 tenantId) external view returns (bool);
  function getAgent(bytes32 agentId) external view returns (AgentRegistration memory);
}
```

Third-party agents cannot self-register. Registration requires an EIP-712 signature from the tenant that authorizes the specific scope. The scope document itself stays off-chain; only its hash is anchored. The canonical scope document enumerates capability grants: `ledger:read`, `wiki:read`, `raw:write`, `payment_intent:propose`, `execution:propose`. A tenant grants any subset.

### BrainEscrow

Holds conditional USDC escrow locks on Base Sepolia and exposes release/cancel
paths that are bound by the pre-execution gate's escrow state check. The
contract is testnet-only and unaudited today.

### BrainReputationRegistry

Publishes reputation roots on Base Sepolia. The contract exists, but the current
scoring implementation is a neutral placeholder until production reputation
inputs are live.

### What's Deferred

Any Brain-native token: not until post-PMF, per the business plan's own sequencing.

## 5. What's Out of Scope for MVP

Being explicit here matters. Investors will ask what the MVP doesn't do; this is the answer.

Graph database. Postgres + recursive CTEs + pgvector handle MVP-scale queries.

Consumer surface. Business is the Y1 revenue anchor ($24M of the $30M target). Consumer is Phase 2 per the business plan and not required for the Series A story.

On-premise / customer-cloud deployment. Shared cloud only.

Multi-region. Single region (East US) with cross-region backups.

Every source adapter except the five listed under Raw.

Agent types beyond the nineteen listed under Agent (FX, payroll, tax, on-chain yield). Live money movement is also out of scope by default. Money-movers ship shadowed and require a deliberate per-agent promotion.

Every rail except ACH, ERP writeback, and optional Base on-chain.

Every export format except JSONL/CSV.

SOC 2 Type 2. Target Type 1 in MVP, Type 2 within 12 months of launch.

Ledger entities beyond the eleven listed: positions, securities, FX rates, cost-basis lots, bond/equity holdings.

## 6. What the MVP Proves

Investor-facing, three claims the MVP must defend:

The six-layer stack works end to end. A design partner can connect their bank + ERP, get a continuously-normalized Ledger and continuously-compiled financial memory, author a policy, have an agent propose a payment that passes the deterministic pre-execution gate against the live Ledger, execute it, and export a tamper-evident audit record, all through Brain's API, in under 30 days of onboarding.

The compounding moat is real. Every day a design partner is on Brain, their Ledger gets measurably richer: more reconciled transactions, more verified counterparties, more obligations modeled, more documents linked. Wiki recall improves alongside. This is measurable and shown on a single chart in the investor deck.

External agents work under the same rules. An external agent connects via MCP, reads the Ledger, proposes a PaymentIntent, gets gated by Policy, executed through the tenant's rails, and logged in Audit, no different from an internal Brain agent. This is what makes Brain a protocol and not just a product.

Those three claims close the Series A. Everything in MVP serves them; everything cut from MVP doesn't.

## 7. Team and Sequencing

Against the $4M seed's $2M product + engineering allocation:

1 engineering lead (full-stack TS/Python, infra literate)

2 backend engineers (one owns Raw + Ledger + Wiki, one owns Policy + Agent + Audit)

1 ML/LLM engineer (owns extractors + /wiki/question + agent reasoning)

1 smart contracts engineer (contractor or full-time; ~14 to 16 weeks to ship six contracts + audit)

1 design partner success engineer (pre-sales, integration, feedback loop to product)

Six people, ~15 months of runway. Ships MVP in 6 months, lands 15 to 25 design partners in months 6 to 12, converts a subset to paid in months 9 to 15, closes Series A on the back of that revenue + the three proof points above.

## 8. What We Build Next (Not Now)

Signaled here for the investor conversation, not scoped for MVP:

Graph substrate as a read-side view (Apache AGE or Neo4j) when query patterns demand it

Promoting the shadowed money-movers (`treasury`, `payment`, `bill_management`, `savings`) to live money movement, and additional agent types beyond the nineteen shipped (FX, payroll, tax-filing, on-chain yield)

Consumer surface

Institutional API tier with committed-volume contracts

Geographic expansion (SEPA, UPI, Pix adapters)

Bring-Your-Own-Source (BYOS) adapter framework: a published SDK that lets developers author tenant-facing ingestion adapters for sources Brain does not have first-party support for (Slack, Teams, vertical CRMs, custom internal systems). Adapters authenticate against Brain, stream data in Brain's Raw schema, and rely on Brain's extraction pipeline. Deferred because the regulatory and compliance surface expands materially when arbitrary developer code is inside the ingestion path.

Cross-tenant agent memory (with explicit tenant-consent flow and anonymization guarantees): lets an agent operating across multiple tenants contribute anonymized signals from tenant A that improve reasoning quality for tenant B, while preserving data sovereignty. Requires a governance and legal framework that does not exist at MVP.

Franchise / white-label tier

Native coordination token

End of MVP blueprint v0.4. The next artifact is the 6-month engineering plan decomposing Phase 1 into weekly milestones.
