# Proposals

An **agent proposal** is a non-financial agent output: vendor risk, collections, treasury, cash forecast, dispute, compliance, revenue intel, reconciliation, subscription, and fraud anomaly findings. A human reviews it and records a decision. This is a separate surface from [Payment Intents](payment-intents.md), which is the gated money-movement path.

| Property          | Value                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| **Layer**         | Execution service, `agent_proposals` table                                                                      |
| **Created by**    | Internal agents                                                                                                 |
| **Never**         | Touches a rail, or reaches an `executed` state                                                                  |
| **Distinct from** | The financial `proposals` table, which carries a PaymentIntent's proposed action through the pre-execution gate |

### The `agent_proposals` Row

```sql
agent_proposals (
  id,
  tenant_id,
  type,                -- vendor_risk | payment_batch | collections | treasury |
                        -- cash_forecast | dispute | compliance | revenue_intel |
                        -- reconciliation | subscription | fraud_anomaly
  agent_principal,
  risk_band,            -- low | standard | elevated | high
  execution_mode,       -- propose | notify_only
  status,               -- needs_review | acknowledged | approved | rejected | undone_to_review
  title,
  amount,               -- optional decimal string
  confidence,
  narrative,
  evidence,             -- [{ text, wiki_entity_id? }]
  links,                -- { payment_intent_id?, counterparty_id?, raw_id? }
  policy_decision_id,
  reversible,
  decision,
  decision_edit,
  decided_by,
  decided_at,
  created_at
)
```

### State Machine

`execution_mode` gates which decisions are legal from `needs_review`: a `propose` proposal can be approved or rejected; a `notify_only` proposal can only be acknowledged. A `reversible` approved proposal can be walked back to `undone_to_review` for a second look, then re-decided.

| From               | Decision           | To                 | Condition                      |
| ------------------ | ------------------ | ------------------ | ------------------------------ |
| `needs_review`     | `approved`         | `approved`         | `execution_mode = propose`     |
| `needs_review`     | `rejected`         | `rejected`         | `execution_mode = propose`     |
| `needs_review`     | `acknowledged`     | `acknowledged`     | `execution_mode = notify_only` |
| `approved`         | `undone_to_review` | `undone_to_review` | `reversible = true`            |
| `undone_to_review` | `approved`         | `approved`         |                                |
| `undone_to_review` | `rejected`         | `rejected`         |                                |

Any other combination is refused with `409 agent_proposal_invalid_state`.

### Relation to PaymentIntents

A PaymentIntent is the only path to money movement, and always passes the [pre-execution gate](the-pre-execution-gate.md). An agent proposal never dispatches a rail; a `payment_batch` proposal that a human approves still requires a separate PaymentIntent to actually move money. The `links.payment_intent_id` field lets a proposal reference the PaymentIntent it relates to once one exists.

### Audit

Every decision emits an audit event: `layer: "agent"`, `action: "proposal.decided"`, with `inputs.type` (the proposal type) and `outputs.decision` / `outputs.proposal_id`. The full history of any agent proposal is reconstructable from `audit_events`.

### Evidence Resolution

`evidence` entries carry free text plus an optional `wiki_entity_id`. When present, resolve the entity for its current state via:

```http
GET /v1/wiki/entity/{id}
```

An entry with no `wiki_entity_id` is evidence the agent observed directly (e.g. an invoice flag) that has no corresponding Wiki page yet.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>💵 Payment Intents</strong></td><td>The gated money-movement path.</td><td><a href="payment-intents.md">payment-intents.md</a></td><td></td></tr><tr><td><strong>🤖 Agents</strong></td><td>How internal and external agents propose actions.</td><td><a href="agents.md">agents.md</a></td><td></td></tr></tbody></table>
