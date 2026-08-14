# Tools

Brain's MCP surface exposes **17 tools** across six capability groups. Each tool requires a specific scope, granted to the agent via on-chain registration in `BrainMCPAgentRegistry`. None of them accept a `tenant_id` argument -- the tenant comes from the JWT, never from the request body.

### At a Glance

| Tool                         | Group          | Required Scope               | Mutates State                        |
| ---------------------------- | -------------- | ---------------------------- | ------------------------------------ |
| `ledger.account.get`         | Ledger read    | `ledger:read`                | No                                   |
| `ledger.accounts.list`       | Ledger read    | `ledger:read`                | No                                   |
| `ledger.transactions.list`   | Ledger read    | `ledger:read`                | No                                   |
| `ledger.obligations.list`    | Ledger read    | `ledger:read`                | No                                   |
| `ledger.counterparties.list` | Ledger read    | `ledger:read`                | No                                   |
| `wiki.question`              | Wiki read      | `wiki:read`                  | No                                   |
| `wiki.page.get`              | Wiki read      | `wiki:read`                  | No                                   |
| `raw.contribute`             | Raw            | `raw:write`                  | Yes (writes Raw artifact)            |
| `raw.artifact.get`           | Raw            | `raw:read`                   | No                                   |
| `payment_intent.propose`     | PaymentIntent  | `payment_intent:propose`     | Yes (writes PaymentIntent in Ledger) |
| `payment_intent.cancel`      | PaymentIntent  | `payment_intent:propose`     | Yes (cancels own proposal)           |
| `payment_intent.list`        | PaymentIntent  | `ledger:read`                | No                                   |
| `agent.action.propose`       | Agent action   | `execution:propose`          | Yes (writes Proposal)                |
| `proposals.list`             | Proposals read | `execution:read`             | No                                   |
| `proposals.get`              | Proposals read | `execution:read`             | No                                   |
| `proposals.decide`           | Proposals read | member authority (see below) | Yes (records a human decision)       |
| `evidence.resolve`           | Proposals read | `execution:read`             | No                                   |

{% hint style="warning" %}
**There is no `payment_intent.execute` tool.** External agents only ever propose. Execution is Brain-internal: an approved intent is dispatched by Brain's own settlement path, never by the proposing agent. A human (or a signed `allow` policy decision) supplies the approval that an intent needs before that internal path runs it; the human does not call a settlement endpoint. Every execution, attended or unattended, passes the same [deterministic pre-execution gate](../protocol/the-pre-execution-gate.md): 13 numbered checks plus 10 hardening additions (23 entries total; several record `not_applicable` until their loaders are wired, so the canonical happy path is the 13 numbered checks). It is the only path to settlement.
{% endhint %}

### Ledger Reads

#### `ledger.account.get`

Fetch a single account by id.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "ledger.account.get",
    "arguments": {
      "account_id": "acct_8231"
    }
  }
}
```

Returns the full Ledger account row including `current_balance`, `available_balance`, `provenance`, `confidence`, and the `source_ids` and `evidence_ids` arrays.

#### `ledger.accounts.list`

List accounts for the calling tenant.

| Argument       | Type    | Description                                       |
| -------------- | ------- | ------------------------------------------------- |
| `status`       | string  | Optional: `active`, `closed`, `frozen`, `pending` |
| `account_type` | string  | Optional                                          |
| `limit`        | integer | Optional, 1-500                                   |

#### `ledger.transactions.list`

Filter Ledger transactions. There is no cursor or amount-range filter on this tool.

| Argument          | Type          | Description                                                                |
| ----------------- | ------------- | -------------------------------------------------------------------------- |
| `account_id`      | string        | Optional, filter to one account                                            |
| `counterparty_id` | string        | Optional                                                                   |
| `direction`       | string        | Optional: `inflow`, `outflow`, `transfer`, `adjustment`                    |
| `status`          | string        | Optional: `pending`, `posted`, `cleared`, `failed`, `reversed`, `disputed` |
| `since`           | ISO date-time | Optional lower bound                                                       |
| `until`           | ISO date-time | Optional upper bound                                                       |
| `limit`           | integer       | Optional, 1-1000                                                           |

#### `ledger.obligations.list`

List the tenant's outstanding obligations: bills, invoices, subscriptions, loans, rent, payroll, tax, card statements. This tool does not accept a `counterparty_id` filter.

| Argument     | Type          | Description                                                             |
| ------------ | ------------- | ----------------------------------------------------------------------- |
| `status`     | string        | Optional: `upcoming`, `due`, `paid`, `overdue`, `cancelled`, `disputed` |
| `type`       | string        | Optional                                                                |
| `due_before` | ISO date-time | Optional                                                                |
| `limit`      | integer       | Optional, 1-500                                                         |

#### `ledger.counterparties.list`

Search counterparties by name or type.

| Argument | Type    | Description                                                                                                    |
| -------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `q`      | string  | Optional, fuzzy-matches counterparty name                                                                      |
| `type`   | string  | Optional: `merchant`, `vendor`, `customer`, `employer`, `bank`, `wallet`, `exchange`, `tax_authority`, `other` |
| `limit`  | integer | Optional, 1-500                                                                                                |

There is no `verified_status` filter on this tool. The response items include `verified_status` per counterparty, but it cannot be used to filter the query.

### Wiki Reads

#### `wiki.question`

Ask the tenant's financial brain a natural-language question. The answer grounds in **Ledger rows**, not Wiki text. Wiki provides retrieval scaffolding; cited facts come from the Ledger.

```json
{
  "name": "wiki.question",
  "arguments": {
    "question": "Did our cloud spend grow faster than revenue this quarter?"
  }
}
```

| Argument             | Type          | Description                 |
| -------------------- | ------------- | --------------------------- |
| `question`           | string        | Required, 1-2000 characters |
| `as_of`              | ISO date-time | Optional                    |
| `max_evidence_depth` | integer       | Optional, 1-5               |

Returns a `content` array whose first entry's text is the rendered question and answer, plus `structuredContent` with the typed `answer`, `evidence` (an array of `{ entityId, entityType, excerpt }`), `model`, and token `usage`.

#### `wiki.page.get`

Fetch a Wiki page by slug or id. Eight page types are available: `/accounts/{id}`, `/counterparties/{id}`, `/obligations/{id}`, `/invoices/{id}`, `/agents/{id}`, `/policies/{id}`, `/monthly-summaries/{YYYY-MM}`, `/cash-flow/{period}`.

| Argument     | Type   | Description |
| ------------ | ------ | ----------- |
| `slug_or_id` | string | Required    |

The response includes the markdown body, structured sections (Current Truth, Key Linked Entities, Recent Activity, Open Questions, Risk Notes, Timeline, Evidence Links), and the `source_revision` checksum at render time.

### Raw

#### `raw.contribute`

Push a Raw artifact into the tenant's Raw layer. The artifact is content-addressed by SHA-256 and attributed to the agent's on-chain registration record (`agent_id`, `agent_role` are written into `source_ref` automatically). It is ingested with `source_type=agent_contributed`.

| Argument     | Type   | Description                                                        |
| ------------ | ------ | ------------------------------------------------------------------ |
| `payload`    | string | Required. Artifact bytes as a string: JSON, plain text, or base64. |
| `mime_type`  | string | Optional, default `application/json`                               |
| `source_ref` | object | Optional: additional source-specific identifiers                   |

There is no `artifact_type` argument and no `signature` argument. Brain does not accept or verify a caller-supplied signature on this tool; attribution comes from the authenticated agent principal, not from a signed payload.

{% hint style="info" %}
**Quarantine on first N contributions.** Agent-contributed artifacts are filtered from standard extraction pipelines until the tenant confirms the agent is trusted. Default trust level: quarantine for the first N contributions, auto-approve after.
{% endhint %}

Confidence on derived Ledger rows is capped at **0.5** for `provenance=agent_contributed`. Tenant or human review is required to lift the cap.

[**→ Agent Contributions**](../protocol/agent-contributions.md)

#### `raw.artifact.get`

Read one tenant-scoped raw artifact's provenance metadata and parsed evidence. Does not return `blob_uri` and does not mint a signed URL for the underlying bytes.

| Argument         | Type    | Description                                      |
| ---------------- | ------- | ------------------------------------------------ |
| `raw_id`         | string  | Required                                         |
| `include_parsed` | boolean | Optional, default `true`: include parser outputs |

### PaymentIntent Propose

#### `payment_intent.propose`

Propose a financial action. Brain creates a `PaymentIntent` row in the Ledger in `proposed` status, runs Policy, and returns a decision. **No execute path on MCP.**

| Argument                      | Type             | Description                                                                                                                                                                                                                                                                |
| ----------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action_type`                 | string           | Required: `ach_outbound`, `ach_inbound`, `wire`, `onchain_transfer`, `erp_writeback`, `card_payment`, `x402_settle`, `escrow_release` (same enum as the HTTP API). `x402_settle` additionally requires `pay_to`; `escrow_release` requires `escrow_id` + `job_terms_hash`. |
| `source_account_id`           | string           | Required                                                                                                                                                                                                                                                                   |
| `destination_counterparty_id` | string           | Required                                                                                                                                                                                                                                                                   |
| `amount`                      | decimal string   | Required                                                                                                                                                                                                                                                                   |
| `currency`                    | string           | Required: ISO-4217 (3 letters) for fiat rails, `USDC` for on-chain settlement types                                                                                                                                                                                        |
| `obligation_id`               | string           | Optional: links the intent to an obligation                                                                                                                                                                                                                                |
| `invoice_id`                  | string           | Optional                                                                                                                                                                                                                                                                   |
| `evidence_ids`                | array of strings | Optional                                                                                                                                                                                                                                                                   |
| `pay_to`                      | string           | Required only for `x402_settle`: `0x` EVM address                                                                                                                                                                                                                          |
| `escrow_id`, `job_terms_hash` | string           | Required only for `escrow_release`: `0x` bytes32 each                                                                                                                                                                                                                      |

There is no `idempotency_key` argument on this or any other MCP tool. Retry deduplication for `payment_intent.propose` is enforced the same way the underlying `PaymentIntentService.create` enforces it for the HTTP route, not by a caller-supplied key at the tool layer.

Response includes the `payment_intent_id`, the `PolicyDecision`, and the next-step instruction (`pending_approval` with required approvers, or `approved` if policy returned `auto`).

[**→ Payment Intents**](../protocol/payment-intents.md)

#### `payment_intent.cancel`

Cancel a PaymentIntent the calling agent itself proposed, while it is still in `proposed` or `pending_approval` state. Only the proposing agent may cancel one of its own intents; the underlying service also enforces that cancel is reachable only from those two states.

| Argument    | Type   | Description |
| ----------- | ------ | ----------- |
| `intent_id` | string | Required    |

#### `payment_intent.list`

List the calling agent's own PaymentIntents. Tenant- and agent-scoped: `agent_id` is forced server-side to the calling agent, so a caller can never list another agent's intents even if it tries to supply one. This tool requires `ledger:read`, not `payment_intent:propose`.

| Argument | Type    | Description                                                                                                                  |
| -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `status` | string  | Optional: `proposed`, `pending_approval`, `approved`, `paused`, `dispatching`, `rejected`, `executed`, `failed`, `cancelled` |
| `limit`  | integer | Optional, 1-100                                                                                                              |

### Agent Action Propose

#### `agent.action.propose`

Propose a non-financial action. Used by reconciliation, anomaly, or any agent action that does not move money. Unlike the HTTP surface, this tool takes a single free-form `action` object rather than separate `action_type`/`payload`/`linked_entities` fields.

| Argument | Type   | Description                                                                                                         |
| -------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `action` | object | Required. Free-form JSON object validated against the policy DSL on evaluation. Must include a string `kind` field. |

There is no top-level `action_type`, `payload`, `linked_entities`, or `idempotency_key` argument -- those all live (or do not exist at all) inside the `action` object itself, at the policy DSL's discretion.

The proposal goes through Policy and lands as a `proposals` row. Approval and dispatch follow the standard flow.

### Proposals and Evidence

These four tools mirror the HTTP [Proposals API](../api-reference/proposals-api.md) exactly. They share its read model and decision service, so tenant scoping, actor resolution, member authority, and the money-path approval gates behave identically over MCP.

#### `proposals.list`

List customer-facing agent proposals across payment intents and non-money findings. Tenant-scoped and cursor-paginated.

| Argument         | Type    | Description                                      |
| ---------------- | ------- | ------------------------------------------------ |
| `type`           | string  | Optional: one of the public proposal types.      |
| `status`         | string  | Optional: lifecycle status filter.               |
| `risk_band`      | string  | Optional: `low`, `standard`, `elevated`, `high`. |
| `min_confidence` | number  | Optional: float in `[0, 1]`.                     |
| `limit`          | integer | Optional: `1` to `100`.                          |
| `cursor`         | string  | Optional: pagination cursor.                     |

Public proposal types are `vendor_risk`, `payment`, `collections`, `treasury`,
`cash_forecast`, `dispute`, `compliance`, `revenue_intel`, `reconciliation`,
`subscription`, `fraud_anomaly`, `personal_budget`, `financial_health`,
`purchase_advisor`, `tax_prep`, `travel_finance`, `bill_management`,
`debt_optimization`, and `savings`.

Each returned proposal mirrors the HTTP read model, including the compact fields
plus `stored_action_type`, `details`, `policy`, `presentation`, and
`available_decisions`. Stored action names are mapped to public proposal types by
Brain Core before they are returned. For example, `flag_transaction` returns as
`fraud_anomaly`, `block_payment` as `vendor_risk`, and `propose_match` as
`reconciliation`; ambiguous names such as `notify` resolve through the agent
role.

#### `proposals.get`

Read one tenant-scoped proposal by id.

| Argument      | Type   | Description |
| ------------- | ------ | ----------- |
| `proposal_id` | string | Required    |

#### `proposals.decide`

Record a human decision on a proposal. Delegates to the same decision service as the HTTP route, including user-principal actor resolution, active-member checks, approval-role checks, money-path approval gates, and audit.

| Argument      | Type   | Description                                          |
| ------------- | ------ | ---------------------------------------------------- |
| `proposal_id` | string | Required                                             |
| `decision`    | string | Required: `approve`, `reject`, `acknowledge`, `undo` |

{% hint style="warning" %}
`proposals.decide` declares no tool-level scope because authority is enforced downstream. The call boundary accepts either `payment_intent:approve` or `execution:read`; the caller must then resolve to a **user-principal, active member with approval authority**. A propose-only agent principal is rejected with `actor_unresolved`: an agent can list and read proposals but can never decide one.
{% endhint %}

#### `evidence.resolve`

Resolve typed proposal evidence refs into tenant-scoped summaries and deep links where the ref kind is supported.

| Argument | Type  | Description                               |
| -------- | ----- | ----------------------------------------- |
| `refs`   | array | Required: up to 50 `{ kind, ref }` pairs. |

Resolution fails closed: a supported ref that does not exist returns `not_found`, and an unsupported kind or malformed ref returns `resolvable: false` with a `reason`, never an error. Resolvable kinds: `account`, `counterparty`, `invoice`, `obligation`, `transaction`, `wiki_entity`.

### Per-Call Scope Enforcement

Even with the right top-level scope, each tool call is scope-checked at invocation. A token with `ledger:read` cannot call `wiki.question`. A token with `wiki:read` cannot call `raw.contribute`. The MCP layer rejects scope mismatches with JSON-RPC error `-32002` (scope insufficient / tenant mismatch). `-32004` is reserved for pre-execution gate failures; the not-found family of errors (a valid-looking id that does not resolve to anything, e.g. `ledger_row_not_found`, `payment_intent_not_found`) is `-32602`. See the [error reference](../resources/errors.md).

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📦 Resources</strong></td><td>Address Ledger and Raw rows by URI.</td><td><a href="resources.md">resources.md</a></td><td></td></tr><tr><td><strong>💬 Prompts</strong></td><td>Canned prompts for common agent loops.</td><td><a href="prompts.md">prompts.md</a></td><td></td></tr><tr><td><strong>🪪 Authentication</strong></td><td>JWT and on-chain scope verification.</td><td><a href="mcp-authentication.md">mcp-authentication.md</a></td><td></td></tr></tbody></table>
