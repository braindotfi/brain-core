# Resources

Brain's MCP server exposes **7 resource templates** that let agents address Brain entities by URI. Resources complement tools: where tools are verbs (`tools/call`), resources are nouns (`resources/read`).

| Property           | Value                            |
| ------------------ | -------------------------------- |
| **URI scheme**     | `brain://`                       |
| **MCP method**     | `resources/read`                 |
| **Required scope** | Same as the equivalent read tool |

### The 7 Templates

| Resource                       | URI Pattern                                          | Required Scope           |
| ------------------------------ | ---------------------------------------------------- | ------------------------ |
| **Ledger account**             | `brain://ledger/accounts/{account_id}`               | `ledger:read`            |
| **Ledger transaction**         | `brain://ledger/transactions/{transaction_id}`       | `ledger:read`            |
| **Ledger obligation**          | `brain://ledger/obligations/{obligation_id}`         | `ledger:read`            |
| **Payment intent**             | `brain://ledger/payment-intents/{payment_intent_id}` | `ledger:read`            |
| **Wiki page**                  | `brain://wiki/pages/{slug}`                          | `wiki:read`              |
| **PaymentIntent action types** | `brain://payments/action_types`                      | `payment_intent:propose` |
| **Action proof (H-07)**        | `brain://proofs/{action_id}`                         | `audit:read`             |

### Why Resources

Tools are good for queries with arguments. Resources are good for entities with stable identifiers that an agent already knows about: a transaction id from a recent `ledger.transactions.list` response, a payment intent id from a previous propose, a wiki page slug like `/monthly-summaries/2025-09`.

Treating them as resources rather than tool calls has three benefits:

| Benefit              | Detail                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| **Cacheable**        | An MCP runtime can cache resource reads by URI without understanding the tool's argument shape |
| **Context-friendly** | Agents can pass URIs back and forth in their planning context without re-fetching              |
| **Discoverable**     | `resources/list` enumerates the URI templates Brain advertises                                 |

### Reading a Resource

```http
POST /v1/agents/mcp HTTP/1.1
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "resources/read",
  "params": {
    "uri": "brain://ledger/transactions/tx_4127"
  }
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "contents": [
      {
        "uri": "brain://ledger/transactions/tx_4127",
        "mimeType": "application/json",
        "text": "{ \"id\": \"tx_4127\", \"amount\": \"61404.12\", \"currency\": \"USD\", ... }"
      }
    ]
  }
}
```

### URI Examples

```
brain://ledger/accounts/acct_8231
brain://ledger/transactions/tx_4127
brain://ledger/obligations/obl_5521
brain://ledger/payment-intents/pi_a1b2c3
brain://wiki/pages/monthly-summaries/2025-09
brain://wiki/pages/counterparties/cp_aws
brain://payments/action_types
brain://proofs/act_01HW3X9...
```

{% hint style="info" %}
The Wiki URI uses the page slug, not the page id. Slugs are stable across regenerations; ids change when a page is regenerated. For agent context that needs to survive regeneration, use the slug.
{% endhint %}

### Resource Discovery

#### `resources/list`

Returns the 7 static URI templates Brain advertises. It is not a per-entity enumeration: the response is the fixed template set below, not one row per account, page, or artifact.

```json
{
  "resources": [
    {
      "uri": "brain://ledger/accounts/{account_id}",
      "name": "Account",
      "description": "Account row + latest balance.",
      "mimeType": "application/json"
    },
    {
      "uri": "brain://ledger/transactions/{transaction_id}",
      "name": "Transaction",
      "description": "Transaction row.",
      "mimeType": "application/json"
    },
    {
      "uri": "brain://ledger/obligations/{obligation_id}",
      "name": "Obligation",
      "description": "Obligation row.",
      "mimeType": "application/json"
    },
    {
      "uri": "brain://ledger/payment-intents/{id}",
      "name": "PaymentIntent",
      "description": "PaymentIntent row + PolicyDecision id.",
      "mimeType": "application/json"
    },
    {
      "uri": "brain://wiki/pages/{slug}",
      "name": "Wiki page",
      "description": "Memory page (markdown body).",
      "mimeType": "text/markdown"
    },
    {
      "uri": "brain://payments/action_types",
      "name": "PaymentIntent action types",
      "description": "Canonical action_type vocabulary + required fields for payment_intent.propose.",
      "mimeType": "application/json"
    },
    {
      "uri": "brain://proofs/{action_id}",
      "name": "Action proof (H-07)",
      "description": "Canonical proof for an executed action: gate trace, policy decision, audit before/after, Merkle proof, and on-chain anchor tx hash.",
      "mimeType": "application/json"
    }
  ]
}
```

{% hint style="info" %}
Only `resources/list` and `resources/read` are implemented. There is no `resources/templates/list` method on the Brain MCP surface.
{% endhint %}

### What Resources Are Not

| Not a Resource                 | Why                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------- |
| Lists, queries, search results | Tools handle those (`*.list`)                                                |
| Newly proposed entities        | The propose tool is the canonical entry point; resources are for fetch-by-id |
| Streaming feeds                | Single-shot HTTP today; streaming may follow when there is a clear use case  |

### Audit

Every successful `resources/read` emits an `agent.mcp.tool_called` audit event with `method: "resources/read"` and the URI in `inputs`. This means a tenant can see exactly which agent fetched which entity at which time, just like for tool calls.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🛠️ Tools</strong></td><td>The 16 tools at the heart of the MCP surface.</td><td><a href="tools.md">tools.md</a></td><td></td></tr><tr><td><strong>💬 Prompts</strong></td><td>Canned prompts for common agent loops.</td><td><a href="prompts.md">prompts.md</a></td><td></td></tr></tbody></table>
