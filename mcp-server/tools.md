# Tools

Brain's MCP surface exposes **16 tools** across five capability groups. Each tool requires a specific scope, granted to the agent via on-chain registration in `BrainMCPAgentRegistry`.

### At a Glance

| Tool                         | Group          | Required Scope           | Mutates State                        |
| ---------------------------- | -------------- | ------------------------ | ------------------------------------ |
| `ledger.account.get`         | Ledger read    | `ledger:read`            | No                                   |
| `ledger.accounts.list`       | Ledger read    | `ledger:read`            | No                                   |
| `ledger.transactions.list`   | Ledger read    | `ledger:read`            | No                                   |
| `ledger.obligations.list`    | Ledger read    | `ledger:read`            | No                                   |
| `ledger.counterparties.list` | Ledger read    | `ledger:read`            | No                                   |
| `wiki.question`              | Wiki read      | `wiki:read`              | No                                   |
| `wiki.page.get`              | Wiki read      | `wiki:read`              | No                                   |
| `raw.contribute`             | Raw contribute | `raw:write`              | Yes (writes Raw artifact)            |
| `payment_intent.propose`     | PaymentIntent  | `payment_intent:propose` | Yes (writes PaymentIntent in Ledger) |
| `payment_intent.cancel`      | PaymentIntent  | `payment_intent:propose` | Yes (cancels own proposal)           |
| `payment_intent.list`        | PaymentIntent  | `payment_intent:propose` | No                                   |
| `agent.action.propose`       | Agent action   | `execution:propose`      | Yes (writes Proposal)                |
| `proposals.list`             | Proposals read | `execution:read`         | No                                   |
| `proposals.get`              | Proposals read | `execution:read`         | No                                   |
| `proposals.decide`           | Proposals read | member authority (see below) | Yes (records a human decision)   |
| `evidence.resolve`           | Proposals read | `execution:read`         | No                                   |

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
      "tenant_id": "acme",
      "account_id": "acct_8231"
    }
  }
}
```

Returns the full Ledger account row including `current_balance`, `available_balance`, `provenance`, `confidence`, and the `source_ids` and `evidence_ids` arrays.

#### `ledger.accounts.list`

List accounts for a tenant.

| Argument       | Type   | Description                                 |
| -------------- | ------ | ------------------------------------------- |
| `tenant_id`    | string | Required                                    |
| `account_type` | string | Optional: `bank`, `card`, `loan`, `onchain` |
| `status`       | string | Optional: `active`, `closed`                |
| `cursor`       | string | Optional pagination cursor                  |

#### `ledger.transactions.list`

Filter and paginate Ledger transactions.

| Argument                   | Type     | Description                                                                |
| -------------------------- | -------- | -------------------------------------------------------------------------- |
| `tenant_id`                | string   | Required                                                                   |
| `account_id`               | string   | Optional, filter to one account                                            |
| `from`, `to`               | ISO date | Optional date range                                                        |
| `direction`                | string   | Optional: `inflow`, `outflow`, `transfer`, `adjustment`                    |
| `counterparty_id`          | string   | Optional                                                                   |
| `status`                   | string   | Optional: `pending`, `posted`, `cleared`, `failed`, `reversed`, `disputed` |
| `min_amount`, `max_amount` | decimal  | Optional                                                                   |
| `cursor`                   | string   | Optional                                                                   |

#### `ledger.obligations.list`

List the tenant's outstanding obligations: bills, invoices, subscriptions, loans, rent, payroll, tax, card statements.

| Argument          | Type     | Description                                                             |
| ----------------- | -------- | ----------------------------------------------------------------------- |
| `tenant_id`       | string   | Required                                                                |
| `status`          | string   | Optional: `upcoming`, `due`, `paid`, `overdue`, `cancelled`, `disputed` |
| `due_before`      | ISO date | Optional                                                                |
| `counterparty_id` | string   | Optional                                                                |
| `type`            | string   | Optional                                                                |

#### `ledger.counterparties.list`

List or search counterparties.

| Argument          | Type   | Description                                                                                                    |
| ----------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| `tenant_id`       | string | Required                                                                                                       |
| `query`           | string | Optional, fuzzy-matches `name`, `normalized_name`, `aliases[]`                                                 |
| `type`            | string | Optional: `merchant`, `vendor`, `customer`, `employer`, `bank`, `wallet`, `exchange`, `tax_authority`, `other` |
| `verified_status` | string | Optional                                                                                                       |

### Wiki Reads

#### `wiki.question`

Ask the tenant's financial brain a natural-language question. The answer grounds in **Ledger rows**, not Wiki text. Wiki provides retrieval scaffolding; cited facts come from the Ledger.

```json
{
  "name": "wiki.question",
  "arguments": {
    "tenant_id": "acme",
    "question": "Did our cloud spend grow faster than revenue this quarter?"
  }
}
```

Returns:

```json
{
  "content": [{ "type": "text", "text": "..." }],
  "metadata": {
    "ledger_evidence": [{ "type": "ledger_transactions", "id": "tx_..." }],
    "wiki_pages_cited": [{ "slug": "/monthly-summaries/2025-09", "page_id": "wpg_..." }],
    "audit_event_id": "evt_..."
  }
}
```

#### `wiki.page.get`

Fetch a Wiki page by slug or id. Eight page types are available: `/accounts/{id}`, `/counterparties/{id}`, `/obligations/{id}`, `/invoices/{id}`, `/agents/{id}`, `/policies/{id}`, `/monthly-summaries/{YYYY-MM}`, `/cash-flow/{period}`.

| Argument     | Type   | Description |
| ------------ | ------ | ----------- |
| `tenant_id`  | string | Required    |
| `slug_or_id` | string | Required    |

The response includes the markdown body, structured sections (Current Truth, Key Linked Entities, Recent Activity, Open Questions, Risk Notes, Timeline, Evidence Links), and the `source_revision` checksum at render time.

### Raw Contribute

#### `raw.contribute`

Push a Raw artifact (transcript, document, structured observation) into the tenant's Raw layer. Artifact is content-addressed by SHA-256, attributed to the agent's on-chain registration record, and carries the agent's signature in its provenance.

| Argument        | Type          | Description                                                          |
| --------------- | ------------- | -------------------------------------------------------------------- |
| `tenant_id`     | string        | Required                                                             |
| `artifact_type` | string        | Required: `transcript`, `document`, `observation`                    |
| `mime_type`     | string        | Required                                                             |
| `content`       | base64 string | Required, the artifact bytes                                         |
| `source_ref`    | object        | Optional: source-specific identifiers                                |
| `signature`     | hex string    | Required: the agent's signature over content + tenant_id + timestamp |

{% hint style="info" %}
**Quarantine on first N contributions.** Agent-contributed artifacts are filtered from standard extraction pipelines until the tenant confirms the agent is trusted. Default trust level: quarantine for the first N contributions, auto-approve after.
{% endhint %}

Confidence on derived Ledger rows is capped at **0.5** for `provenance=agent_contributed`. Tenant or human review is required to lift the cap.

[**→ Agent Contributions**](../protocol/agent-contributions.md)

### PaymentIntent Propose

#### `payment_intent.propose`

Propose a financial action. Brain creates a `PaymentIntent` row in the Ledger in `proposed` status, runs Policy, and returns a decision. **No execute path on MCP.**

| Argument                      | Type    | Description                                                                                                                                                                                                                                                                |
| ----------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_id`                   | string  | Required                                                                                                                                                                                                                                                                   |
| `action_type`                 | string  | Required: `ach_outbound`, `ach_inbound`, `wire`, `onchain_transfer`, `erp_writeback`, `card_payment`, `x402_settle`, `escrow_release` (same enum as the HTTP API). `x402_settle` additionally requires `pay_to`; `escrow_release` requires `escrow_id` + `job_terms_hash`. |
| `source_account_id`           | string  | Required                                                                                                                                                                                                                                                                   |
| `destination_counterparty_id` | string  | Required                                                                                                                                                                                                                                                                   |
| `amount`                      | decimal | Required                                                                                                                                                                                                                                                                   |
| `currency`                    | string  | Required                                                                                                                                                                                                                                                                   |
| `obligation_id`               | string  | Optional: links the intent to an obligation                                                                                                                                                                                                                                |
| `invoice_id`                  | string  | Optional                                                                                                                                                                                                                                                                   |
| `idempotency_key`             | string  | Required: caller-supplied unique key per intent                                                                                                                                                                                                                            |

Response includes the `payment_intent_id`, the `PolicyDecision`, and the next-step instruction (`pending_approval` with required approvers, or `approved` if policy returned `auto`).

[**→ Payment Intents**](../protocol/payment-intents.md)

### Agent Action Propose

#### `agent.action.propose`

Propose a non-financial action. Used by reconciliation, anomaly, or any agent action that doesn't move money.

| Argument          | Type   | Description                                                                                                                |
| ----------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| `tenant_id`       | string | Required                                                                                                                   |
| `action_type`     | string | Required: `reconciliation_match`, `anomaly_flag`, `categorize_transaction`, `merge_counterparty`, `link_document`, `other` |
| `payload`         | object | Action-specific payload                                                                                                    |
| `linked_entities` | array  | Optional: array of `{ type, id }` references                                                                               |
| `idempotency_key` | string | Required                                                                                                                   |

The proposal goes through Policy and lands as a `proposals` row. Approval and dispatch follow the standard flow.

### Proposals and Evidence

These four tools mirror the HTTP [Proposals API](../api-reference/proposals-api.md) exactly. They share its read model and decision service, so tenant scoping, actor resolution, member authority, and the money-path approval gates behave identically over MCP.

#### `proposals.list`

List customer-facing agent proposals across payment intents and non-money findings. Tenant-scoped and cursor-paginated.

| Argument         | Type    | Description                                                                    |
| ---------------- | ------- | ------------------------------------------------------------------------------ |
| `type`           | string  | Optional: one of the eleven agent types.                                       |
| `status`         | string  | Optional: lifecycle status filter.                                             |
| `risk_band`      | string  | Optional: `low`, `standard`, `elevated`, `high`.                               |
| `min_confidence` | number  | Optional: float in `[0, 1]`.                                                    |
| `limit`          | integer | Optional: `1` to `100`.                                                        |
| `cursor`         | string  | Optional: pagination cursor.                                                    |

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
`proposals.decide` declares no tool-level scope because authority is enforced downstream. The caller must resolve to a **user-principal, active member with approval authority**. A propose-only agent principal is rejected with `actor_unresolved`: an agent can list and read proposals but can never decide one.
{% endhint %}

#### `evidence.resolve`

Resolve typed proposal evidence refs into tenant-scoped summaries and deep links where the ref kind is supported.

| Argument | Type  | Description                                             |
| -------- | ----- | ------------------------------------------------------ |
| `refs`   | array | Required: up to 50 `{ kind, ref }` pairs.              |

Resolution fails closed: a supported ref that does not exist returns `not_found`, and an unsupported kind or malformed ref returns `resolvable: false` with a `reason`, never an error. Resolvable kinds: `account`, `counterparty`, `invoice`, `obligation`, `transaction`, `wiki_entity`.

### Per-Call Scope Enforcement

Even with the right top-level scope, each tool call is scope-checked at invocation. A token with `ledger:read` cannot call `wiki.question`. A token with `wiki:read` cannot call `raw.contribute`. The MCP layer rejects scope mismatches with JSON-RPC error `-32002` (scope insufficient / tenant mismatch). `-32004` is reserved for pre-execution gate failures; see the [error reference](../resources/errors.md).

### Idempotency

Mutating tools (`raw.contribute`, `payment_intent.propose`, `agent.action.propose`) require an `idempotency_key`. The key is per-tool, per-tenant, per-agent. Brain caches the response for 24 hours and returns the cached result on retry.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📦 Resources</strong></td><td>Address Ledger and Raw rows by URI.</td><td><a href="resources.md">resources.md</a></td><td></td></tr><tr><td><strong>💬 Prompts</strong></td><td>Canned prompts for common agent loops.</td><td><a href="prompts.md">prompts.md</a></td><td></td></tr><tr><td><strong>🪪 Authentication</strong></td><td>JWT and on-chain scope verification.</td><td><a href="mcp-authentication.md">mcp-authentication.md</a></td><td></td></tr></tbody></table>
