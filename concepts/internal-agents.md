---
description: Brain-shipped agents are first-class participants, not a parallel system.
---

# Internal Agents

Brain ships a small set of its own agents (for example, collections, treasury, and reconciliation). These **internal agents** are not a separate mechanism. They register in the same registry, pass the same validation, and propose through the same path as any third-party agent. The only thing that distinguishes them is a metadata field and who operates the execution key.

## Three Kinds of Caller

| Kind            | Who builds it              | Provenance | Credential                         |
| --------------- | -------------------------- | ---------- | ---------------------------------- |
| **Internal**    | Brain ships it             | `internal` | Brain-operated execution key       |
| **First-party** | The customer's own backend | n/a        | Server API key                     |
| **External**    | A third party              | `external` | JWT anchored to an on-chain record |

"Internal" and "external" are values of the agent's `provenance` metadata (stored as the agent record's `kind`). "First-party" describes a customer backend calling Brain with its own API key; it is a usage pattern, not a registry entry.

## Same Registry, Same Validation

An internal agent is registered in `BrainMCPAgentRegistry` exactly like an external one: an `agentId`, an execution address, a per-tenant `scopeHash`, and a tenant-signed authorization. When an internal agent settles on-chain, it executes under the same `BrainSmartAccount` session-key model as any agent. The owner first `grantSessionKey`s the agent's execution address with a `policyVersion` bound at grant time and on-chain spend caps (per-tx and per-period). Each settlement then calls `executeViaSessionKey`, which enforces:

1. the session key is granted, not paused, and within its validity window,
2. the supplied nonce matches the per-holder replay nonce,
3. the call stays within the per-tx and per-period spend caps, and
4. the key's `policyVersion` matches what `BrainPolicyRegistry` returns.

The owner can `pauseSessionKey`/`unpauseSessionKey` or `revokeSessionKey` at any time. There is no `BrainNativeAgent` and no bypass. Capabilities are identified by `keccak256(name)` and fold into the agent's `scopeHash`, the same as for external agents.

## The Shared Pattern

Every internal agent is described by an **agent definition**: its capabilities, the events and intent patterns it responds to, the data it may read, its risk level, its minimum confidence, the evidence it requires, and its default authority. A handler turns a triggered action into a proposal. The agent never executes; it proposes through `POST /v1/agents/{id}/propose`, which runs Policy and the deterministic pre-execution gate.

## Routing

A multi-agent router selects an agent for an incoming event or intent. It filters candidates by capability and by the tenant's scope grants, scores them by trigger match, intent match, evidence completeness, reputation, and cost, and returns the best agent plus fallbacks. The selection is itself an audit event, so a tenant can later verify why a particular agent was chosen. Routing only selects; the selected agent still proposes through the gated path.

## The Decision

The proposal decision stays `ALLOW`, `ESCALATE`, or `DENY`. Internal agents add three fields to that response without changing it: `confidence`, `evidence_score`, and an `execution_mode` of `execute`, `propose`, `confirm`, `notify_only`, or `reject`. Low confidence or missing required evidence yields `notify_only`: surface to a human, take no action. Existing callers who read `decision` are unaffected.

## The Business Agent Library

Brain ships a library of business-category internal agents. Every one follows the shared pattern above: a `keccak256` capability, a definition, a handler that only proposes, and a `policy.template.json` a tenant can adopt. None of them moves money outside `POST /v1/agents/{id}/propose` and the pre-execution gate.

| Agent                    | Capability             | Risk   | Typical mode             |
| ------------------------ | ---------------------- | ------ | ------------------------ |
| **Collections**          | `collections_followup` | medium | propose                  |
| **Treasury**             | `treasury_sweep`       | medium | propose / confirm        |
| **Payment**              | `payment_propose`      | medium | confirm (financial)      |
| **Vendor Risk**          | `vendor_risk`          | high   | confirm / reject (block) |
| **Cash Forecasting**     | `cash_forecast`        | low    | notify_only / propose    |
| **Dispute**              | `dispute_evidence`     | medium | propose                  |
| **Compliance**           | `compliance_monitor`   | high   | notify_only / confirm    |
| **Revenue Intelligence** | `revenue_intel`        | low    | notify_only              |

A high-risk agent never auto-executes: even at high confidence, its actions resolve to `confirm` (or `reject`), because `execution_mode` only reaches `execute` for low-risk actions.

## The Consumer Agent Library

Brain also ships consumer-category agents for individuals. They follow the same pattern, but their `policy.template.json` defaults are more conservative than the business templates: smaller per-action caps and `notify_only` as the default authority for any medium- or high-risk agent.

| Agent                 | Capability          | Risk   | Typical mode                |
| --------------------- | ------------------- | ------ | --------------------------- |
| **Personal Budget**   | `personal_budget`   | low    | propose                     |
| **Bill Management**   | `bill_management`   | medium | confirm (financial)         |
| **Savings**           | `savings_sweep`     | low    | confirm (financial)         |
| **Debt Optimization** | `debt_optimization` | medium | confirm (financial)         |
| **Tax Prep**          | `tax_prep`          | low    | propose                     |
| **Travel Finance**    | `travel_finance`    | low    | propose                     |
| **Financial Health**  | `financial_health`  | low    | notify_only                 |
| **Purchase Advisor**  | `purchase_advisor`  | medium | notify_only (intent-driven) |

Three internal agents are **agnostic** and serve business and consumer tenants alike: **Subscription** (`subscription_review`), **Reconciliation** (`reconciliation_review`), and **Fraud & Anomaly** (`fraud_anomaly`). The Subscription agent is shared, not duplicated: it ships a stricter `policy.consumer.template.json` for consumer tenants rather than a separate consumer agent.

## Category-Aware Routing

Some triggers are shared across categories: `cash.balance_high` matches both **Treasury** (business) and **Savings** (consumer); `bill.due_soon` matches both **Payment** (business) and **Bill Management** (consumer). The router resolves the tenant's category (business or consumer) and prefers the category-matching agent, so a business tenant routes `cash.balance_high` to Treasury and a consumer tenant routes it to Savings.

Category mismatch is a **scoring downgrade, not a hard reject**: a mismatched agent is penalized but can still win when it is the best (or only) match. So an explicit user intent ("help me save") can override the default category preference. Agnostic agents carry no penalty. When no tenant category is resolved, routing is category-blind and behaves exactly as in the earlier phases.

## Intent Classification

A request that carries a free-form intent (rather than a domain event) is scored against each agent's declared `intent_patterns`. Two classifier strategies share one interface, selected by the `AGENT_INTENT_CLASSIFIER` flag:

| Strategy      | Flag value        | How it matches                                                                                                                                      |
| ------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rules**     | `rules` (default) | Token overlap with patterns. Deterministic, no dependencies; misses paraphrases.                                                                    |
| **Embedding** | `embedding`       | Cosine similarity between intent and pattern embeddings. Matches paraphrases; pattern embeddings are cached and reindexed when the catalog changes. |

The embedding strategy keeps the **rules classifier as a live fallback**: when an intent scores below the similarity threshold, or the embedding service is unavailable, the router falls back to token overlap. The two strategies are interchangeable behind the same interface, so routing and selection scoring are unchanged. Only the source of the intent-match score differs. With the flag off (the default), behavior is identical to the earlier phases.

## Autonomous Execution (Agent Autonomy)

The library is hardened for production autonomous execution, with money-movement off by default:

- **Shadow mode + graduated promotion.** Every agent is shadowed by default. A financial proposal terminates as `shadow_completed` and moves no money. Going live is a deliberate, per-agent promotion gated by strict caps (signed spend envelopes + `approval_required_above`) and an allowlisted rail. The five money-movers (Treasury, Payment, Bill Management, Savings, Debt Optimization) are promoted one at a time.
- **Action resolution.** Within a selected agent, the action is resolved explicit → event-map → intent-map → opt-in default; unresolved actions persist as `missing_action`, never a silent default. Money-movers/high-risk agents have no default action.
- **Behavior pinning.** Each agent registers a `behaviorHash`; the gate (check 1.5) rejects a runtime model/prompt/tool drift. Promotion to a new behavior needs tenant re-attestation.
- **High-risk agents** (Vendor Risk, Compliance) emit auditable **findings** before any block/confirm, with a tenant-root override-and-document path.
- **Counterparty-facing agents** (Collections, Dispute, Subscription) send only **tenant-approved message templates** from the signed policy doc. No free-form prose to customers/vendors.
- **Observability.** Every run persists a structured reason and trace; `GET /v1/agents/runs/{id}/why` returns the full reason + gate trace + rail receipt.

See the API reference for the `/v1/agents/run`, `/why`, and kill-switch endpoints.

## Related

| Topic                          | Page                                                                 |
| ------------------------------ | -------------------------------------------------------------------- |
| The shared authorization model | [Agents](agents.md)                                                  |
| How agent actions are gated    | [Policy](policy.md)                                                  |
| The agent layer in depth       | [Protocol: Agents](../protocol/agents.md)                            |
| The on-chain identity contract | [BrainMCPAgentRegistry](../smart-contracts/brainmcpagentregistry.md) |
